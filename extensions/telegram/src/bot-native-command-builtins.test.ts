import { Bot } from "grammy";
import { resolveFastModeState } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTelegramBuiltinCommand } from "./bot-native-command-builtins.js";
import type { TelegramCommandExecutorParams } from "./bot-native-command-dispatch.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

const mocks = vi.hoisted(() => ({
  prepareDispatch: vi.fn(),
  getSessionEntry: vi.fn<(params: { sessionKey: string }) => SessionEntry | undefined>(),
}));

vi.mock("./bot-native-command-dispatch.js", () => ({
  prepareTelegramCommandDispatch: mocks.prepareDispatch,
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.getSessionEntry,
  resolveStorePath: () => "/synthetic/telegram-menu-session-store",
}));
vi.mock("openclaw/plugin-sdk/command-auth-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/command-auth-native")>();
  return { ...actual, resolveFastModeState: vi.fn(actual.resolveFastModeState) };
});

const parentKey = "agent:main:main";
const currentKey = `${parentKey}:thread:77`;
const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      model: "menu-test/default",
      models: {
        "menu-test/default": { params: { fastMode: false, fastAutoOnSeconds: 90 } },
        "menu-test/selected": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
      },
    },
  },
};
const message = {
  message_id: 1,
  date: 1,
  chat: { id: 123, type: "private" as const, first_name: "Menu tester" },
  text: "/fast",
};
const bot = new Bot("123:menu-test-token", { botInfo: telegramBotInfoForTest });
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const executorParams: TelegramCommandExecutorParams = {
  bot,
  botUser: telegramBotInfoForTest,
  msg: message,
  rawText: "",
  runtime,
  accountId: "default",
  resolveGroupPolicy: () => "open",
  resolveTelegramGroupConfig: () => ({}),
  opts: { token: "123:menu-test-token" },
};

function entry(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "menu-session", updatedAt: 1, ...fields };
}

const selectedModel = {
  providerOverride: "menu-test",
  modelOverride: "selected",
  modelOverrideSource: "user" as const,
};

beforeEach(() => {
  mocks.prepareDispatch.mockReset().mockResolvedValue({
    bot,
    runtime,
    runtimeCfg: cfg,
    route: { agentId: "main" },
    targetSessionKey: currentKey,
    chatId: message.chat.id,
    threadParams: { message_thread_id: 77 },
  });
  mocks.getSessionEntry.mockReset();
  vi.mocked(resolveFastModeState).mockReset();
  vi.spyOn(bot.api, "sendMessage").mockResolvedValue(message);
});
afterEach(() => vi.restoreAllMocks());

async function expectFastMenu(status: string, seconds: number) {
  expect(await executeTelegramBuiltinCommand({ ...executorParams, commandName: "fast" })).toBe(
    "handled",
  );
  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    123,
    `${status}\nOptions: on, off, auto (${seconds} sec), default, status.`,
    {
      message_thread_id: 77,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "on", callback_data: "tgcmd:/fast on" },
            { text: "off", callback_data: "tgcmd:/fast off" },
          ],
          [
            { text: `auto (${seconds} sec)`, callback_data: "tgcmd:/fast auto" },
            { text: "default", callback_data: "tgcmd:/fast default" },
          ],
          [{ text: "status", callback_data: "tgcmd:/fast status" }],
        ],
      },
    },
  );
}

describe("Telegram fast argument menu", () => {
  it.each<{
    name: string;
    current?: Partial<SessionEntry>;
    parent?: Partial<SessionEntry>;
    status: string;
    seconds: number;
  }>([
    { name: "missing session", status: "Current fast mode: off (default: model).", seconds: 90 },
    {
      name: "direct user model",
      current: selectedModel,
      status: "Current fast mode: auto (30 sec) (default: model).",
      seconds: 30,
    },
    {
      name: "parent user model",
      current: { fastMode: true },
      parent: selectedModel,
      status: "Current fast mode: on (session).",
      seconds: 30,
    },
    {
      name: "explicit default model",
      current: { modelOverrideSource: "default" },
      parent: selectedModel,
      status: "Current fast mode: off (default: model).",
      seconds: 90,
    },
    {
      name: "current automatic fallback",
      current: { ...selectedModel, modelOverrideSource: "auto", fastMode: true },
      status: "Current fast mode: on (session).",
      seconds: 90,
    },
    {
      name: "parent automatic fallback",
      parent: {
        ...selectedModel,
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "menu-test",
        modelOverrideFallbackOriginModel: "default",
      },
      status: "Current fast mode: off (default: model).",
      seconds: 90,
    },
  ])("preserves status and choices for $name", async ({ current, parent, status, seconds }) => {
    mocks.getSessionEntry.mockImplementation(({ sessionKey }) => {
      const fields =
        sessionKey === currentKey ? current : sessionKey === parentKey ? parent : undefined;
      return fields ? entry(fields) : undefined;
    });
    await expectFastMenu(status, seconds);
  });

  it.each([
    { fastMode: false, label: "off" },
    { fastMode: true, label: "on" },
    { fastMode: "auto", label: "auto (30 sec)" },
    { fastMode: "ultrafast", label: "ultrafast" },
  ] as const)("keeps the current session's $label mode", async ({ fastMode, label }) => {
    mocks.getSessionEntry.mockReturnValue(entry({ ...selectedModel, fastMode }));
    await expectFastMenu(`Current fast mode: ${label} (session).`, 30);
  });

  it("retains session mode when the parent model lookup fails", async () => {
    mocks.getSessionEntry.mockImplementation(({ sessionKey }) => {
      if (sessionKey === parentKey) {
        throw new Error("parent store unavailable");
      }
      return entry({ fastMode: true });
    });
    await expectFastMenu("Current fast mode: on (session).", 90);
  });

  it("uses configured defaults when the current entry cannot be read", async () => {
    mocks.getSessionEntry.mockImplementation(() => {
      throw new Error("current store unavailable");
    });
    await expectFastMenu("Current fast mode: off (default: model).", 90);
  });

  it("retains model choices when fast-state resolution falls back", async () => {
    mocks.getSessionEntry.mockReturnValue(entry({ ...selectedModel, fastMode: true }));
    vi.mocked(resolveFastModeState).mockImplementationOnce(() => {
      throw new Error("selected state unavailable");
    });
    await expectFastMenu("Current fast mode: off (default: model).", 30);
  });
});
