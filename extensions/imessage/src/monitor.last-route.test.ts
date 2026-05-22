import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { loadIMessageCatchupCursor } from "./monitor/catchup.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const recordInboundSessionMock = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (_params: { ctx: MsgContext }) =>
      ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }) as const,
  ),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: recordInboundSessionMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) => await opts.onFlush([entry]),
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage monitor last-route updates", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    recordInboundSessionMock.mockClear();
    dispatchInboundMessageMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const runtimeErrorMock = vi.fn();
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello from imessage",
              is_group: false,
              date: 1_714_000_000_000,
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { dmScope: "per-channel-peer", mainKey: "main" },
      } as never,
      runtime: { error: runtimeErrorMock, exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1);
    });
    expect(runtimeErrorMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    });
    const recordParams = recordInboundSessionMock.mock.calls.at(0)?.[0] as
      | {
          sessionKey?: string;
          updateLastRoute?: {
            channel?: string;
            mainDmOwnerPin?: unknown;
            sessionKey?: string;
            to?: string;
          };
        }
      | undefined;
    expect(recordParams?.sessionKey).toBe("agent:main:imessage:direct:+15550001111");
    expect(recordParams?.updateLastRoute?.sessionKey).toBe(recordParams?.sessionKey);
    expect(recordParams?.updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(recordParams?.updateLastRoute?.channel).toBe("imessage");
    expect(recordParams?.updateLastRoute?.to).toBe("+15550001111");
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });

  it("advances the catchup cursor after startup catchup succeeds and a live row is handled", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-live-cursor-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [] };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 77,
              guid: "LIVE-GUID-77",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello after catchup",
              is_group: false,
              created_at: "2026-05-22T15:30:00.000Z",
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(async () => {
      expect((await loadIMessageCatchupCursor("default"))?.lastSeenRowid).toBe(77);
    });
  });
});
