import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachIMessageMonitorAbortHandlerMock = vi.hoisted(() =>
  vi.fn<typeof attachIMessageMonitorAbortHandler>(() => () => {}),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachIMessageMonitorAbortHandlerMock,
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

type MockIMessageRpcClient = IMessageRpcClient & {
  request: ReturnType<
    typeof vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>
  >;
  waitForClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createRpcClient(overrides?: {
  request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}): MockIMessageRpcClient {
  const client = {
    request: vi.fn(
      overrides?.request ??
        (async () => {
          return { subscription: 1 };
        }),
    ),
    waitForClose: vi.fn(
      overrides?.waitForClose ??
        (async () => {
          return undefined;
        }),
    ),
    stop: vi.fn(async () => {}),
  };
  return client as unknown as MockIMessageRpcClient;
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    attachIMessageMonitorAbortHandlerMock.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.resetModules();
  });

  it("retries a transient watch.subscribe startup timeout without tearing down the monitor", async () => {
    const runtime = createRuntime();
    const firstClient = createRpcClient({
      request: async () => {
        throw new Error("imsg rpc timeout (watch.subscribe)");
      },
    });
    const secondClient = createRpcClient();

    createIMessageRpcClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const monitorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    });

    await vi.runAllTimersAsync();
    await monitorPromise;

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.waitForClose).toHaveBeenCalledTimes(1);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain(
      "imessage: watch.subscribe startup failed (attempt 1/3): Error: imsg rpc timeout (watch.subscribe); retrying",
    );
    expect(
      runtime.error.mock.calls.some(([message]) =>
        String(message).includes("imessage: monitor failed"),
      ),
    ).toBe(false);
  });

  it("repairs anchorless live payloads before debounce classification", async () => {
    const runtime = createRuntime();
    let notify: ((msg: { method: string; params?: unknown }) => void) | undefined;
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = createRpcClient({
      waitForClose: async () => await closed,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [{ id: 101 }, { id: 202 }] };
        }
        if (method === "messages.history") {
          if (params?.chat_id === 101) {
            return {
              messages: [
                {
                  guid: "GUID-GROUP-A",
                  chat_id: 101,
                  chat_guid: "iMessage;+;group-a",
                  chat_identifier: "group-a",
                  is_group: true,
                  participants: ["+15550001111", "+15550002222"],
                },
              ],
            };
          }
          if (params?.chat_id === 202) {
            return {
              messages: [
                {
                  guid: "GUID-GROUP-B",
                  chat_id: 202,
                  chat_guid: "iMessage;+;group-b",
                  chat_identifier: "group-b",
                  is_group: true,
                  participants: ["+15550001111", "+15550003333"],
                },
              ],
            };
          }
          return { messages: [] };
        }
        return {};
      },
    });

    createIMessageRpcClientMock.mockImplementation(async (opts) => {
      notify = opts?.onNotification;
      return client;
    });

    const monitorPromise = monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            coalesceSameSenderDms: true,
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
        messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      } as never,
      runtime: runtime as never,
    });

    await vi.waitFor(() => expect(notify).toBeDefined());

    const baseMessage = {
      chat_id: 0,
      sender: "+15550001111",
      is_from_me: false,
      attachments: null,
      chat_identifier: "",
      chat_guid: "",
      chat_name: "",
      participants: null,
      is_group: false,
    };
    notify?.({
      method: "message",
      params: { message: { ...baseMessage, guid: "GUID-GROUP-A", text: "first group" } },
    });
    notify?.({
      method: "message",
      params: { message: { ...baseMessage, guid: "GUID-GROUP-B", text: "second group" } },
    });

    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.method === "messages.history" && call.params?.chat_id === 202),
      ).toHaveLength(1),
    );

    expect(calls.filter((call) => call.method === "chats.list")).toHaveLength(2);
    expect(
      calls.filter((call) => call.method === "messages.history" && call.params?.chat_id === 101),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.method === "messages.history" && call.params?.chat_id === 202),
    ).toHaveLength(1);

    close();
    await monitorPromise;
  });

  it("still fails after bounded startup retries are exhausted", async () => {
    const runtime = createRuntime();
    createIMessageRpcClientMock.mockImplementation(async () =>
      createRpcClient({
        request: async () => {
          throw new Error("imsg rpc timeout (watch.subscribe)");
        },
      }),
    );

    const monitorErrorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    }).catch((error) => error);

    await vi.runAllTimersAsync();
    const monitorError = await monitorErrorPromise;

    expect(monitorError).toBeInstanceOf(Error);
    expect((monitorError as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(3);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(String(runtime.error.mock.calls[0]?.[0])).toContain(
      "imessage: monitor failed: Error: imsg rpc timeout (watch.subscribe)",
    );
  });
});
