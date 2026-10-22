import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramCallbackContext } from "./bot.test-helpers.js";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

const { answerCallbackQuerySpy, getLoadConfigMock, getOnHandler, sendMessageSpy } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { runWithTelegramUpdateProcessingFrame } = await import("./bot-processing-outcome.js");
const makeConfig = () => makeTelegramConfig({ dmPolicy: "open", allowFrom: ["*"] });
let state: OpenClawTestState;

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  state = await createOpenClawTestState({ label: "telegram-callback-retry", layout: "state-only" });
  clearPluginInteractiveHandlers();
  getLoadConfigMock().mockReturnValue(makeConfig());
});
afterEach(async () => {
  clearPluginInteractiveHandlers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
  vi.restoreAllMocks();
});

async function createCallback(text: string, error?: string) {
  const handler = vi.fn(async ({ respond }: TelegramInteractiveHandlerContext) => {
    await respond.reply({ text });
    if (error) {
      throw new Error(error);
    }
    return { handled: true };
  });
  registerPluginInteractiveHandler("callback-fixture", {
    channel: "telegram",
    namespace: "callback-fixture",
    // SAFETY: The registry erases channel context; only Telegram dispatches this fixture.
    handler: (context) => handler(context as TelegramInteractiveHandlerContext),
  });
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  const context = createTelegramCallbackContext({
    id: error ? "callback-failure" : "expired-ack",
    data: "callback-fixture:choice",
    message: { message_id: 11, text: "Select a thread" },
  });
  return { handler, context, callbackHandler: getOnHandler("callback_query") };
}

it.each([
  { message: "Gateway requester authority changed", reason: "callback-authority-changed" },
  { message: "gateway unavailable", reason: undefined },
])("classifies a spooled callback failure: $message", async ({ message, reason }) => {
  const text = "This action is no longer available.";
  const { callbackHandler, context } = await createCallback(text, message);
  const update = { update_id: 404, callback_query: context.callbackQuery };
  const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
    channelId: "telegram",
    accountId: "default",
  });
  const monitor = createTelegramIngressMonitor({
    queue,
    accountId: "default",
    getConfig: makeConfig,
    dispatch: (rawUpdate) =>
      runWithTelegramUpdateProcessingFrame(() =>
        callbackHandler({ ...context, update: rawUpdate }),
      ).then(({ result }) => result),
  });
  monitor.start();
  try {
    await monitor.admit(update);
    await monitor.waitForIdle();
    expect(await queue.listFailed?.()).toMatchObject(reason ? [{ reason }] : []);
    expect(await queue.listPending()).toMatchObject(reason ? [] : [{ attempts: 1 }]);
    if (reason) {
      monitor.requestDrain();
      await monitor.waitForIdle();
    }
    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(1234, text, undefined);
  } finally {
    await monitor.stop();
  }
});

it("processes a callback action after its acknowledgment expires", async () => {
  answerCallbackQuerySpy.mockRejectedValueOnce(new Error("400: query is too old"));
  const { handler, callbackHandler, context } = await createCallback("Action completed.");
  await callbackHandler(context);
  expect(handler).toHaveBeenCalledOnce();
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(1234, "Action completed.", undefined);
});
