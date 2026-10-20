// Real callback routing and durable ingress; external Telegram effects are deterministic fakes.
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
import type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "./interactive-dispatch.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

const { answerCallbackQuerySpy, getLoadConfigMock, getOnHandler, sendMessageSpy } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { runWithTelegramUpdateProcessingFrame } = await import("./bot-processing-outcome.js");
const openDirect = () => ({ dmPolicy: "open" as const, allowFrom: ["*"] });
let state: OpenClawTestState;

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  state = await createOpenClawTestState({ label: "telegram-callback-retry", layout: "state-only" });
  clearPluginInteractiveHandlers();
  getLoadConfigMock().mockReturnValue(makeTelegramConfig(openDirect()));
});
afterEach(async () => {
  clearPluginInteractiveHandlers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
  vi.restoreAllMocks();
});

async function createTelegramPluginCallbackHandler(params: {
  handler: TelegramInteractiveHandlerRegistration["handler"];
}) {
  registerPluginInteractiveHandler("callback-fixture", {
    channel: "telegram",
    namespace: "callback-fixture",
    // SAFETY: The registry erases channel context; only Telegram dispatches this fixture.
    handler: (context) => params.handler(context as TelegramInteractiveHandlerContext),
  });
  await createTelegramBotCore({ token: "tok", botInfo: telegramBotInfoForTest });
  return getOnHandler("callback_query");
}

function makeCallbackContext(id: string, data: string, message: Record<string, unknown>) {
  return createTelegramCallbackContext({ id, data, message });
}

it.each([
  { message: "Gateway requester authority changed", reason: "callback-authority-changed" },
  { message: "gateway unavailable", reason: undefined },
])("classifies a spooled callback failure: $message", async ({ message, reason }) => {
  const callbackHandler = await createTelegramPluginCallbackHandler({
    handler: async ({ respond }) => {
      await respond.reply({ text: "This action is no longer available." });
      throw new Error(message);
    },
  });
  const context = makeCallbackContext("callback-failure", "callback-fixture:choice", {
    message_id: 11,
    text: "Select a thread",
  });
  const update = { update_id: 404, callback_query: context.callbackQuery };
  const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
    channelId: "telegram",
    accountId: "default",
  });
  const monitor = createTelegramIngressMonitor({
    queue,
    accountId: "default",
    getConfig: () => makeTelegramConfig(openDirect()),
    dispatch: async (rawUpdate) => {
      const { result } = await runWithTelegramUpdateProcessingFrame(() =>
        callbackHandler({ ...context, update: rawUpdate }),
      );
      return result;
    },
  });
  monitor.start();
  try {
    await monitor.admit(update);
    await monitor.waitForIdle();
    if (reason) {
      expect(await queue.listFailed?.()).toMatchObject([{ reason }]);
      expect(await queue.listPending()).toEqual([]);
      monitor.requestDrain();
      await monitor.waitForIdle();
    } else {
      expect(await queue.listFailed?.()).toEqual([]);
      expect(await queue.listPending()).toMatchObject([{ attempts: 1 }]);
    }
    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
  } finally {
    await monitor.stop();
  }
});

it("processes a callback action after its acknowledgment expires", async () => {
  answerCallbackQuerySpy.mockRejectedValueOnce(new Error("400: query is too old"));
  const handler = vi.fn(async ({ respond }: TelegramInteractiveHandlerContext) => {
    await respond.reply({ text: "Action completed." });
    return { handled: true };
  });
  const callbackHandler = await createTelegramPluginCallbackHandler({ handler });
  await callbackHandler(
    makeCallbackContext("expired-ack", "callback-fixture:choice", {
      message_id: 11,
      text: "Select a thread",
    }),
  );
  expect(handler).toHaveBeenCalledOnce();
  expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(1234, "Action completed.", undefined);
});
