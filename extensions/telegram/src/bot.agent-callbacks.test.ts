import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTelegramConfig, type TelegramChannelConfig } from "./bot.config.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramCallbackContext } from "./bot.test-helpers.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";

const { editMessageReplyMarkupSpy, getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

// callback_data bytes core sends for message-action controls, as recorded by
// test/telegram-agent-control-taps.integration.test.ts.
const AGENT_CALLBACK = "::/pick a|1";

// v2026.11.5 agent envelopes share the opaque envelope's checksum.
const buildLegacyAgentCallback = (value: string) =>
  buildTelegramOpaqueCallbackData(value).replace(/^tgcb1:/u, "tgac1:");

const useConfig = (telegram: TelegramChannelConfig) =>
  getLoadConfigMock().mockReturnValue(makeTelegramConfig(telegram));

beforeEach(async ({ onTestFinished }) => {
  const state = await createOpenClawTestState({ layout: "state-only" });
  onTestFinished(() => state.cleanup());
  clearPluginInteractiveHandlers();
  useConfig({ dmPolicy: "open", allowFrom: ["*"] });
});
afterEach(() => {
  clearPluginInteractiveHandlers();
  vi.restoreAllMocks();
});

async function tap(data: string, message: Record<string, unknown> = {}, from?: { id: number }) {
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  await getOnHandler("callback_query")(
    createTelegramCallbackContext({
      id: "cbq-agent-choice",
      data,
      ...(from ? { from: { ...from, first_name: "Eve" } } : {}),
      message: {
        reply_markup: { inline_keyboard: [[{ text: "Pick", callback_data: data }]] },
        ...message,
      },
    }),
  );
}

it("delivers an unclaimed agent tap to the agent as data without the mark", async () => {
  await tap(AGENT_CALLBACK);

  expect(replySpy).toHaveBeenCalledOnce();
  const body = replySpy.mock.calls[0]?.[0].Body;
  expect(body).toContain("callback_data: /pick a|1");
  expect(body).not.toContain(AGENT_CALLBACK);
  expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
    reply_markup: { inline_keyboard: [] },
  });
  expect(sendMessageSpy).not.toHaveBeenCalled();
});

it("delivers an agent button already sent by v2026.11.5", async () => {
  await tap("tgac1:17dsn:pick:beta");

  expect(replySpy.mock.calls[0]?.[0].Body).toContain("callback_data: pick:beta");
  expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("tgac1");
});

it("keeps the routing of a v2026.11.5 agent button whose value starts with the mark", async () => {
  const handler = vi.fn(async (_ctx: unknown) => ({ handled: true }));
  registerPluginInteractiveHandler("pick-owner", {
    channel: "telegram",
    namespace: "pick",
    handler,
  });
  await tap(buildLegacyAgentCallback("::pick:a"));

  expect(handler).not.toHaveBeenCalled();
  expect(replySpy.mock.calls[0]?.[0].Body).toContain("callback_data: ::pick:a");
});

it("offers an agent tap to the plugin that owns its value first", async () => {
  const handler = vi.fn(async (_ctx: unknown) => ({ handled: true }));
  registerPluginInteractiveHandler("pick-owner", {
    channel: "telegram",
    namespace: "pick",
    handler,
  });
  await tap("::pick:a");

  expect(handler).toHaveBeenCalledOnce();
  expect(handler.mock.calls[0]?.[0]).toMatchObject({
    callback: { data: "pick:a", namespace: "pick", payload: "a" },
  });
  expect(replySpy).not.toHaveBeenCalled();
});

it("delivers an agent tap in a mention-gated group", async () => {
  useConfig({ groupPolicy: "open", groups: { "*": { requireMention: true } } });
  await tap(AGENT_CALLBACK, { chat: { id: -100999, type: "supergroup", title: "Ops" } });

  expect(replySpy).toHaveBeenCalledOnce();
  expect(replySpy.mock.calls[0]?.[0].Body).toContain("callback_data: /pick a|1");
});

it("ignores an agent tap from a sender outside the allowlist", async () => {
  useConfig({ dmPolicy: "allowlist", allowFrom: ["1"] });
  await tap(AGENT_CALLBACK, {}, { id: 9 });

  expect(replySpy).not.toHaveBeenCalled();
  expect(sendMessageSpy).not.toHaveBeenCalled();
  expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
});

it.each([
  ["an unclaimed plugin control", buildTelegramOpaqueCallbackData("pick:a"), "all"],
  ["a malformed legacy agent envelope", "tgac1:invalid", "all"],
  ["a malformed legacy agent envelope with inline buttons off", "tgac1:invalid", "off"],
  ["a legacy agent envelope with an invalid checksum", "tgac1:wrong:pick:a", "all"],
  ["an agent control with inline buttons off", AGENT_CALLBACK, "off"],
] as const)("expires %s", async (_name, data, inlineButtons) => {
  useConfig({ dmPolicy: "open", allowFrom: ["*"], capabilities: { inlineButtons } });
  const handler = vi.fn(async () => ({ handled: true }));
  registerPluginInteractiveHandler("reserved-owner", {
    channel: "telegram",
    namespace: "tgac1",
    handler,
  });
  await tap(data);

  expect(handler).not.toHaveBeenCalled();
  expect(replySpy).not.toHaveBeenCalled();
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
    1234,
    "This action is no longer available.",
    undefined,
  );
});
