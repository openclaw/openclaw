import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramCallbackContext } from "./bot.test-helpers.js";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";

const { answerCallbackQuerySpy, getLoadConfigMock, getOnHandler, sendMessageSpy } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { runWithTelegramSpooledReplayUpdate, runWithTelegramUpdateProcessingFrame } =
  await import("./bot-processing-outcome.js");
const makeConfig = () => makeTelegramConfig({ dmPolicy: "open", allowFrom: ["*"] });

beforeEach(async ({ onTestFinished }) => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const state = await createOpenClawTestState({ layout: "state-only" });
  onTestFinished(() => state.cleanup());
  clearPluginInteractiveHandlers();
  getLoadConfigMock().mockReturnValue(makeConfig());
});
afterEach(() => {
  clearPluginInteractiveHandlers();
  vi.restoreAllMocks();
});

async function createCallback(text: string, error?: string) {
  const handler = async ({ respond }: TelegramInteractiveHandlerContext) => {
    await respond.reply({ text });
    if (error) {
      throw new Error(error);
    }
    return { handled: true };
  };
  registerPluginInteractiveHandler("callback-fixture", {
    channel: "telegram",
    namespace: "callback-fixture",
    // SAFETY: The registry erases channel context; only Telegram dispatches this fixture.
    handler: (context) => handler(context as TelegramInteractiveHandlerContext),
  });
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  const context = createTelegramCallbackContext({
    id: "callback-fixture",
    data: "callback-fixture:choice",
  });
  return { context, callbackHandler: getOnHandler("callback_query") };
}

it("reports a spooled callback failure to the ingress owner", async () => {
  const message = "Gateway requester authority changed";
  const text = "This action is no longer available.";
  const { callbackHandler, context } = await createCallback(text, message);
  const update = { update_id: 404, callback_query: context.callbackQuery };
  const { value } = await runWithTelegramSpooledReplayUpdate(update, () =>
    runWithTelegramUpdateProcessingFrame(() => callbackHandler({ ...context, update })),
  );
  expect(value.result).toEqual({
    kind: "failed-retryable",
    error: new Error(message),
  });
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(1234, text, undefined);
});

it("processes a callback action after its acknowledgment expires", async () => {
  answerCallbackQuerySpy.mockRejectedValueOnce(new Error("400: query is too old"));
  const { callbackHandler, context } = await createCallback("Action completed.");
  await callbackHandler(context);
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(1234, "Action completed.", undefined);
});
