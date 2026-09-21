import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";

const saveRemoteMedia = vi.fn();
vi.mock("./telegram-media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telegram-media.runtime.js")>()),
  saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
}));

export const harness = await import("./bot.create-telegram-bot.test-harness.js");
vi.doUnmock("./bot.runtime.js");
const { createTelegramBot } = await import("./bot.js");
const bots: ReturnType<typeof createTelegramBot>[] = [];
export const chat = { id: 42001, type: "private", first_name: "Alice" } as const;
export const from = { id: 42001, is_bot: false, first_name: "Alice" } as const;
export const groupChat = {
  id: -10042001,
  type: "supergroup",
  title: "Test group",
  is_forum: true,
} as const;
export const photo = [
  { file_id: "photo-1", file_unique_id: "photo-unique", width: 10, height: 10 },
];
export const apiCalls = vi.fn<(method: string, payload: unknown) => void>();

export function createBot(
  native = true,
  text = true,
  override?: OpenClawConfig,
  dmTopicsEnabled = false,
) {
  const cfg: OpenClawConfig = override ?? {
    commands: { native, text },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], streaming: { mode: "off" } } },
  };
  harness.getLoadConfigMock().mockReturnValue(cfg);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const payload: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    apiCalls(method, payload);
    const result =
      method === "getFile"
        ? { file_id: "photo-1", file_unique_id: "photo-unique", file_path: "photo.jpg" }
        : {
            message_id: 200,
            date: 1736380800,
            chat,
            ...(typeof payload.message_thread_id === "number"
              ? { message_thread_id: payload.message_thread_id }
              : {}),
          };
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  const bot = createTelegramBot({
    token: "123:test-token",
    botInfo: { ...telegramBotInfoForTest, has_topics_enabled: dmTopicsEnabled },
    config: cfg,
    telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
    telegramDeps: {
      ...harness.telegramBotDepsForTest,
      syncTelegramMenuCommands: () => {},
    },
  });
  bots.push(bot);
  return bot;
}

let messageId = 10000;

export function commandMessage(text: string) {
  const commandEnd = text.search(/\s/u);
  return {
    message_id: ++messageId,
    date: 1736380800,
    chat,
    from,
    text,
    entities: [
      { type: "bot_command", offset: 0, length: commandEnd < 0 ? text.length : commandEnd },
    ],
  } satisfies Message.TextMessage;
}

export function groupCommand(text = "/status", threadId = 99) {
  return {
    ...commandMessage(text),
    chat: groupChat,
    message_thread_id: threadId,
    is_topic_message: true,
  };
}

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "telegram-native-pipeline" });
});
afterAll(async () => {
  resetPluginStateStoreForTests();
  await state.cleanup();
});

beforeEach(() => {
  state.applyEnv();
  resetPluginStateStoreForTests({ closeDatabase: false });
  apiCalls.mockClear();
  setTelegramPluginStateRuntimeForTests();
  saveRemoteMedia.mockReset().mockResolvedValue({
    id: "replied-photo.jpg",
    path: "/tmp/replied-photo.jpg",
    size: 4,
    contentType: "image/jpeg",
  } satisfies SavedRemoteMedia);
});

afterEach(async () => {
  await Promise.all(bots.splice(0).map((bot) => bot.stop()));
});
