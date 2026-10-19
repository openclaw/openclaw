import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API, Message } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
let sessionSequence = 0;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    // Close the store before removing its files on Windows.
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

vi.mock("./zca-client.js", () => ({
  createZalo: createZaloMock,
  TextStyle: { Indent: 9 },
}));

import { zalouserMessageAdapter } from "./channel.adapters.js";
import { setZalouserRuntime } from "./runtime.js";
import { saveStoredZaloCredentials } from "./session-state.js";
import {
  normalizeZaloInboundMessage,
  resolveZaloGroupContext,
  sendZaloTextMessage,
  startZaloListener,
} from "./zalo-js.js";

type ListenerOn = ReturnType<typeof vi.fn>;

function createMockApi(overrides: Partial<API> = {}): API {
  return {
    getContext: () => ({ imei: "test-imei", userAgent: "test-agent", language: "en" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [{ key: "zpsid", value: "test" }] }) }),
    fetchAccountInfo: async () => ({
      userId: "555444333",
      username: "owner",
      displayName: "Owner",
      zaloName: "Owner",
      avatar: "",
    }),
    listener: {
      on: vi.fn(),
      off: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    ...overrides,
  } as unknown as API;
}

async function withStoredSession<T>(profile: string, api: API, run: () => Promise<T>): Promise<T> {
  const stateDir = tempDirs.make("openclaw-zalouser-message-");
  await saveStoredZaloCredentials(
    profile,
    {
      imei: "test-imei",
      cookie: [{ key: "zpsid", value: "test" }],
      userAgent: "test-agent",
      createdAt: new Date().toISOString(),
    },
    { OPENCLAW_STATE_DIR: stateDir },
  );
  createZaloMock.mockResolvedValueOnce({ login: vi.fn(async () => api) });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

function findListener(listenerOn: ListenerOn, event: string): (message: Message) => void {
  const callback = listenerOn.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof callback !== "function") {
    throw new Error(`Missing ${event} listener`);
  }
  return callback as (message: Message) => void;
}

function createInboundMessage(data: Record<string, unknown>): Message {
  return {
    type: 0,
    threadId: "123456789",
    isSelf: false,
    data: {
      uidFrom: "123456789",
      idTo: "987654321",
      content: "plain message",
      ...data,
    },
  };
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStoreV2 = (options, authority = { assertCurrent: () => {} }) =>
    createPluginStateKeyedStoreV2ForTests("zalouser", options, authority);
  setZalouserRuntime(runtime);
  createZaloMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Zalo payload bounds", () => {
  it("applies the resolved account media cap before the native message send", async () => {
    const sendMessage = vi.fn(async () => ({ msgId: "media-cap" }));
    const api = createMockApi({ sendMessage } as Partial<API>);
    const directory = tempDirs.make("zalouser-media-cap-");
    const file = path.join(directory, "attachment.txt");
    await withStoredSession("media-cap", api, async () => {
      const sendMedia = zalouserMessageAdapter.send?.media;
      if (!sendMedia) {
        throw new Error("Zalo Personal media sender unavailable");
      }
      const params = {
        cfg: {
          channels: {
            zalouser: {
              mediaMaxMb: 10,
              accounts: { Limited: { profile: "media-cap", mediaMaxMb: 1 / 1024 } },
            },
          },
        },
        accountId: "limited",
        to: "user:123456789",
        text: "attachment",
        mediaUrl: file,
        mediaLocalRoots: [directory],
      };
      await writeFile(file, "x".repeat(1536));
      await expect(sendMedia(params)).rejects.toThrow(/exceeds.*limit/i);
      expect(sendMessage).not.toHaveBeenCalled();
      await writeFile(file, "x".repeat(512));
      const result = await sendMedia(params);
      expect(result.messageId).toBe("media-cap");
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [expect.objectContaining({ data: Buffer.from("x".repeat(512)) })],
        }),
        "123456789",
        expect.anything(),
      );
    });
  });

  it("keeps the 2,000-code-unit transport payload UTF-16 well-formed", async () => {
    const sendMessage = vi.fn(async () => ({ msgId: "message-1" }));
    const api = createMockApi({ sendMessage } as Partial<API>);

    await withStoredSession("payload-bounds", api, async () => {
      await expect(
        sendZaloTextMessage("thread-1", `${"x".repeat(1_999)}🚀tail`, {
          profile: "payload-bounds",
        }),
      ).resolves.toMatchObject({
        messageId: "message-1",
        receipt: { platformMessageIds: ["message-1"] },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith("x".repeat(1_999), "thread-1", expect.anything());
  });
});

describe("Zalo inbound normalization", () => {
  async function captureInbound(messages: Message[]) {
    const profile = `listener-${sessionSequence++}`;
    const api = createMockApi();
    const received: Message[] = [];

    await withStoredSession(profile, api, async () => {
      const listener = await startZaloListener({
        accountId: "default",
        profile,
        abortSignal: new AbortController().signal,
        onMessage: (message) => {
          received.push(message);
        },
        onError: vi.fn(),
      });
      const onMessage = findListener(vi.mocked(api.listener.on), "message");
      for (const message of messages) {
        onMessage(message);
      }
      listener.stop();
    });

    return received
      .map((message) => normalizeZaloInboundMessage(message, "555444333"))
      .filter((message): message is NonNullable<typeof message> => message !== null);
  }

  it("extracts quote metadata and implicit mentions", async () => {
    const [message] = await captureInbound([
      createInboundMessage({
        content: "ok",
        ts: 1_764_000_000_000,
        quote: {
          globalMsgId: 987654321234,
          ownerId: "555444333_2",
          msg: "Previous bot message content",
        },
      }),
    ]);

    expect(message).toMatchObject({
      quotedGlobalMsgId: "987654321234",
      quotedOwnerId: "555444333",
      quotedBody: "Previous bot message content",
      implicitMention: true,
    });
  });

  it("normalizes second and millisecond timestamps", async () => {
    const messages = await captureInbound([
      createInboundMessage({ ts: 1_764_000_000 }),
      createInboundMessage({ ts: "1764000000.5" }),
      createInboundMessage({ ts: 1_764_000_000_000 }),
    ]);

    expect(messages.map((message) => message.timestampMs)).toEqual([
      1_764_000_000_000, 1_764_000_000_500, 1_764_000_000_000,
    ]);
  });

  it("falls back for partial or unsafe timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const messages = await captureInbound([
      createInboundMessage({ ts: "1764000000abc" }),
      createInboundMessage({ ts: "9007199254740993" }),
      createInboundMessage({ ts: 8_640_000_000_000_001 }),
    ]);

    expect(messages.map((message) => message.timestampMs)).toEqual([
      1_700_000_000_000, 1_700_000_000_000, 1_700_000_000_000,
    ]);
  });
});

describe("Zalo group context cache", () => {
  it("reuses group context until its five-minute TTL expires", async () => {
    const getGroupInfo = vi.fn(async () => ({
      gridInfoMap: { "group-ttl": { groupId: "group-ttl", name: "Group" } },
    }));
    const api = createMockApi({ getGroupInfo } as Partial<API>);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await withStoredSession("cache-ttl", api, async () => {
      await expect(resolveZaloGroupContext("cache-ttl", "group-ttl")).resolves.toMatchObject({
        groupId: "group-ttl",
        name: "Group",
      });
      now.mockReturnValue(1_700_000_299_999);
      await resolveZaloGroupContext("cache-ttl", "group-ttl");
      expect(getGroupInfo).toHaveBeenCalledOnce();
      now.mockReturnValue(1_700_000_300_000);
      await resolveZaloGroupContext("cache-ttl", "group-ttl");
    });

    expect(getGroupInfo).toHaveBeenCalledTimes(2);
  });
});
