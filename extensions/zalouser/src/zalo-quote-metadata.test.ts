import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { API, Message } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
const sendMessage = vi.fn(async () => ({ msgId: "message-1" }));
let sessionSequence = 0;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    // Close the store before removing its files on Windows.
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

// mock-isolation: Quote fixtures provide synthetic listeners and sends, never a live Zalo session.
vi.mock("./zca-client.js", () => ({ createZalo: createZaloMock, TextStyle: { Indent: 9 } }));

import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import { saveStoredZaloCredentials } from "./session-state.js";
import {
  logoutZaloProfile,
  normalizeZaloInboundMessage,
  resolveZaloGroupContext,
  sendZaloTextMessage,
  startZaloListener,
} from "./zalo-js.js";

class TestListener extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
}

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
    listener: new TestListener(),
    sendMessage,
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

beforeEach(() => {
  resetPluginStateStoreForTests();
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStoreV2 = (options, authority = { assertCurrent: () => {} }) =>
    createPluginStateKeyedStoreV2ForTests("zalouser", options, authority);
  setZalouserRuntime(runtime);
  createZaloMock.mockReset();
  sendMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("applies the resolved account media cap before the native message send", async () => {
  const api = createMockApi();
  const directory = tempDirs.make("zalouser-media-cap-");
  const file = path.join(directory, "attachment.txt");
  await withStoredSession("media-cap", api, async () => {
    const sendMedia = zalouserPlugin.message?.send?.media;
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
    expect(await sendMedia(params)).toMatchObject({ messageId: "message-1" });
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
  const api = createMockApi();

  await withStoredSession("payload-bounds", api, async () => {
    await expect(
      sendZaloTextMessage("thread-1", `${"x".repeat(1_999)}🚀tail`, { profile: "payload-bounds" }),
    ).resolves.toMatchObject({
      messageId: "message-1",
      receipt: { platformMessageIds: ["message-1"] },
    });
  });

  expect(sendMessage).toHaveBeenCalledWith("x".repeat(1_999), "thread-1", expect.anything());
});

async function captureInbound(messages: Record<string, unknown>[]) {
  const profile = `listener-${sessionSequence++}`;
  const events = new TestListener();
  const api = createMockApi({ listener: events });
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
    for (const data of messages) {
      events.emit("message", {
        type: 0,
        threadId: "123456789",
        isSelf: false,
        data: { uidFrom: "123456789", idTo: "987654321", content: "plain message", ...data },
      });
    }
    listener.stop();
  });

  return received
    .map((message) => normalizeZaloInboundMessage(message, "555444333"))
    .filter((message): message is NonNullable<typeof message> => message !== null);
}

it("extracts quote metadata and implicit mentions", async () => {
  const [message] = await captureInbound([
    {
      quote: {
        globalMsgId: 987654321234,
        ownerId: "555444333_2",
        msg: "Previous bot message content",
      },
    },
  ]);

  expect(message).toMatchObject({
    quotedGlobalMsgId: "987654321234",
    quotedOwnerId: "555444333",
    quotedBody: "Previous bot message content",
    implicitMention: true,
  });
});

it.each([
  [1_764_000_000, 1_764_000_000_000],
  ["1764000000.5", 1_764_000_000_500],
  [1_764_000_000_000, 1_764_000_000_000],
  ["1764000000abc", 1_700_000_000_000],
  ["9007199254740993", 1_700_000_000_000],
  [8_640_000_000_000_001, 1_700_000_000_000],
])("normalizes timestamp %s", async (ts, expected) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const messages = await captureInbound([{ ts }]);
  expect(messages.map((message) => message.timestampMs)).toEqual([expected]);
});

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

it("keeps group lookups profile-scoped and refreshes them after logout", async () => {
  const groupId = "shared-group";
  const getGroupInfoA = vi.fn(async () => ({
    gridInfoMap: { [groupId]: { groupId, name: "Alpha" } },
  }));
  const getGroupInfoB = vi.fn(async () => ({
    gridInfoMap: { [groupId]: { groupId, name: "Beta" } },
  }));
  await withStoredSession(
    "cache-alpha",
    createMockApi({ getGroupInfo: getGroupInfoA }),
    async () => {
      await expect(resolveZaloGroupContext("cache-alpha", groupId)).resolves.toMatchObject({
        name: "Alpha",
      });
      await withStoredSession(
        "cache-beta",
        createMockApi({ getGroupInfo: getGroupInfoB }),
        async () => {
          await expect(resolveZaloGroupContext("cache-beta", groupId)).resolves.toMatchObject({
            name: "Beta",
          });
        },
      );
      await expect(resolveZaloGroupContext("cache-alpha", groupId)).resolves.toMatchObject({
        name: "Alpha",
      });
      expect(getGroupInfoA).toHaveBeenCalledOnce();
      expect(getGroupInfoB).toHaveBeenCalledOnce();
      await logoutZaloProfile("cache-alpha");
    },
  );

  const getGroupInfoAfterLogin = vi.fn(async () => ({
    gridInfoMap: { [groupId]: { groupId, name: "New Alpha" } },
  }));
  await withStoredSession(
    "cache-alpha",
    createMockApi({ getGroupInfo: getGroupInfoAfterLogin }),
    async () => {
      await expect(resolveZaloGroupContext("cache-alpha", groupId)).resolves.toMatchObject({
        name: "New Alpha",
      });
    },
  );
  expect(getGroupInfoAfterLogin).toHaveBeenCalledOnce();
});
