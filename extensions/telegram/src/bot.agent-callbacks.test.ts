import { expectDefined as requireValue } from "openclaw/plugin-sdk/expect-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramCallbackContext } from "./bot.test-helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { telegramMessageActions } from "./channel-actions.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";

const { editMessageReplyMarkupSpy, getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

beforeEach(async ({ onTestFinished }) => {
  const state = await createOpenClawTestState({ layout: "state-only" });
  onTestFinished(() => state.cleanup());
  clearPluginInteractiveHandlers();
  getLoadConfigMock().mockReturnValue(makeTelegramConfig({ dmPolicy: "open", allowFrom: ["*"] }));
});
afterEach(() => {
  clearPluginInteractiveHandlers();
  vi.restoreAllMocks();
});

/** Renders one typed callback button through the message(action=send) producer. */
async function renderMessageSendCallback(value: string): Promise<string> {
  const prepared = await telegramMessageActions.prepareSendPayload?.({
    ctx: { channel: "telegram", action: "send", cfg: {}, params: {} },
    to: "1234",
    payload: {
      text: "When?",
      presentation: {
        blocks: [
          { type: "buttons", buttons: [{ label: "Today", action: { type: "callback", value } }] },
        ],
      },
    },
  });
  const rendered = canonicalizeTelegramPresentationPayload(requireValue(prepared, "prepared"));
  const telegram = rendered.channelData?.telegram as { buttons?: TelegramInlineButtons };
  return requireValue(telegram.buttons?.[0]?.[0]?.callback_data, "callback data");
}

async function tap(data: string) {
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  await getOnHandler("callback_query")(
    createTelegramCallbackContext({
      id: "cbq-agent-choice",
      data,
      message: { reply_markup: { inline_keyboard: [[{ text: "Today", callback_data: data }]] } },
    }),
  );
}

it("delivers an unclaimed message-send tap to the agent as callback data", async () => {
  const value = "/usdt remind|today 20:00";
  await tap(await renderMessageSendCallback(value));

  expect(replySpy).toHaveBeenCalledOnce();
  expect(replySpy.mock.calls[0]?.[0].Body).toContain(`callback_data: ${value}`);
  expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
    reply_markup: { inline_keyboard: [] },
  });
  expect(sendMessageSpy).not.toHaveBeenCalled();
});

it.each([
  ["a malformed envelope", "on"],
  ["inline buttons turned off", "off"],
] as const)("expires a message-send tap with %s", async (_name, inlineButtons) => {
  const pluginHandler = vi.fn(async () => ({ handled: true }));
  registerPluginInteractiveHandler("pick-owner", {
    channel: "telegram",
    namespace: "pick",
    handler: pluginHandler,
  });
  const data = inlineButtons === "on" ? "tgac1:invalid" : await renderMessageSendCallback("pick:a");
  if (inlineButtons === "off") {
    getLoadConfigMock().mockReturnValue(
      makeTelegramConfig({
        dmPolicy: "open",
        allowFrom: ["*"],
        capabilities: { inlineButtons: "off" },
      }),
    );
  }
  await tap(data);

  expect(pluginHandler).not.toHaveBeenCalled();
  expect(replySpy).not.toHaveBeenCalled();
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
    1234,
    "This action is no longer available.",
    undefined,
  );
});
