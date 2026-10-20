// Real grammY command handling and SQLite ingress, with a loopback Telegram API.
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import { runTelegramChannelInboundEventWithHarness as runInbound } from "./bot.test-helpers.js";
import * as callbackAnswers from "./callback-query-answer-state.js";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
} from "./runtime.test-support.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

const downstream = vi.hoisted(() =>
  vi.fn(async (_ctx: MsgContext) => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  })),
);
const sessionDirs = useSessionStoreTempDirs(afterAll, "telegram-native-admission-");
const menuSyncs = vi.hoisted(() => new Set<Promise<void>>());
const fixture = useTelegramHttpFixture();

vi.mock("./bot-native-command-menu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bot-native-command-menu.js")>();
  return {
    ...actual,
    syncTelegramMenuCommands: (params: Parameters<typeof actual.syncTelegramMenuCommands>[0]) => {
      const pending = actual.syncTelegramMenuCommands(params);
      menuSyncs.add(pending);
      return pending;
    },
  };
});
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: vi.fn(async () => []),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      runInbound(actual, params, ({ ctx }) => downstream(ctx)),
  };
});

it.each(["none", "middleware", "handler"] as const)(
  "answers a callback during a native menu request with %s ACK recovery",
  async (recovery) => {
    downstream.mockClear();
    const stateDir = sessionDirs.make();
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetPluginStateStoreForTests({ closeDatabase: false });
    resetTelegramAccountThrottlersForTest();
    installTelegramIngressQueueRuntime(() => stateDir);

    const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 10 });
    const callbackRequests = () =>
      fixture.requests.filter(({ method }) => method === "answerCallbackQuery");
    const runtimeErrors: unknown[] = [];
    const actor = { id: 111, is_bot: false, first_name: "Ada" };
    const chat = { id: 111, type: "private", first_name: "Ada" } as const;
    let menu: Message.TextMessage | undefined;
    let heldMenuResponse: ServerResponse | undefined;
    const heldAnswerResponses: ServerResponse[] = [];
    let releaseAnswers = recovery === "none";
    const sendResult = (response: ServerResponse, result: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    };
    const failAnswer = (response: ServerResponse) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error_code: 503, description: "ACK unavailable" }));
    };
    const releaseHeldAnswers = () => {
      releaseAnswers = true;
      for (const response of heldAnswerResponses.splice(0)) {
        sendResult(response, true);
      }
    };
    fixture.handleRequest = (method, payload, response) => {
      if (method === "answerCallbackQuery" && !releaseAnswers) {
        const answerCount = callbackRequests().length;
        if (recovery === "middleware" && answerCount === 1) {
          failAnswer(response);
        } else {
          heldAnswerResponses.push(response);
        }
        return true;
      }
      if (method === "sendMessage" && payload.reply_markup) {
        menu = {
          message_id: 80,
          date: 1_736_380_800,
          chat,
          from: telegramBotInfoForTest,
          text: String(payload.text),
          reply_markup: payload.reply_markup as Message.TextMessage["reply_markup"],
        };
        heldMenuResponse = response;
        return true;
      }
      sendResult(response, true);
      return true;
    };
    const apiRoot = fixture.cfg.channels.telegram.apiRoot;
    const telegramTransport = { fetch, sourceFetch: fetch, close: async () => {} };
    let monitor: ReturnType<typeof createTelegramTransportIngressMonitor> | undefined;
    const handlerAnswerRead = Promise.withResolvers<void>();
    const getHandlerAnswer = callbackAnswers.getTelegramCallbackQueryAnswerPromise;
    const readHandlerAnswer = vi
      .spyOn(callbackAnswers, "getTelegramCallbackQueryAnswerPromise")
      .mockImplementation((ctx) => {
        const answer = getHandlerAnswer(ctx);
        handlerAnswerRead.resolve();
        return answer;
      });
    try {
      const cfg: OpenClawConfig = {
        commands: { native: true, nativeSkills: false },
        channels: { telegram: { apiRoot, dmPolicy: "open", allowFrom: ["*"] } },
        session: { store: path.join(stateDir, "sessions.json") },
      };
      setRuntimeConfigSnapshot(cfg);
      const bot = await createTelegramBot({
        token: "123456:loopback-token",
        botInfo: telegramBotInfoForTest,
        config: cfg,
        telegramTransport,
        runtime: { ...fixture.runtime, error: (error) => runtimeErrors.push(error) },
      });
      const answerRequests = vi.spyOn(bot.api, "answerCallbackQuery");
      const expectAdmissionConsumed = () => {
        expect(
          callbackAnswers.takeTelegramCallbackQueryAdmissionAnswer(bot, "native-menu-callback"),
        ).toBeUndefined();
      };
      monitor = createTelegramTransportIngressMonitor({
        stateDir,
        bot,
        accountId: "default",
        botInfo: telegramBotInfoForTest,
        pollIntervalMs: 10,
        onError: (error) => runtimeErrors.push(error),
      });
      const queue = openTelegramIngressQueue({ stateDir });
      monitor.start();
      await monitor.admit({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1_736_380_800,
          chat,
          from: actor,
          text: "/usage",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      });
      await vi.waitFor(
        () => expect(menu, `native menu not sent: ${runtimeErrors.join("; ")}`).toBeDefined(),
        { timeout: 5_000, interval: 10 },
      );
      expect(await queue.listClaims()).toHaveLength(1);
      expect(downstream).not.toHaveBeenCalled();
      const button = menu?.reply_markup?.inline_keyboard
        .flat()
        .find((entry) => "callback_data" in entry && entry.callback_data === "tgcmd:/usage off");
      expect(button).toBeDefined();
      const callbackUpdate = {
        update_id: 2,
        callback_query: {
          id: "native-menu-callback",
          chat_instance: "native-menu-chat",
          from: actor,
          message: menu,
          data: button && "callback_data" in button ? button.callback_data : undefined,
        },
      };
      const settleDuplicates = async () => {
        await monitor!.admit(callbackUpdate);
        await monitor!.admit(callbackUpdate);
        releaseHeldAnswers();
        await Promise.allSettled(answerRequests.mock.results.map((result) => result.value));
      };
      await monitor.admit(callbackUpdate);
      await vi.waitFor(() => expect(callbackRequests()).toHaveLength(1), {
        timeout: 1_000,
        interval: 10,
      });
      expect(await queue.listClaims()).toHaveLength(1);
      expect(await queue.listPending({ limit: "all" })).toHaveLength(1);
      expect(downstream).not.toHaveBeenCalled();
      if (recovery !== "none") {
        if (recovery === "middleware") {
          const firstAnswer = answerRequests.mock.results[0]?.value;
          expect(firstAnswer).toBeDefined();
          await expect(firstAnswer).rejects.toThrow("ACK unavailable");
        }
        expect(heldMenuResponse).toBeDefined();
        sendResult(heldMenuResponse!, menu);
        heldMenuResponse = undefined;
        // Wait for the router, not a polling deadline, before checking ACK recovery.
        await handlerAnswerRead.promise;
        if (recovery === "handler") {
          const firstResponse = heldAnswerResponses.shift();
          expect(firstResponse).toBeDefined();
          failAnswer(firstResponse!);
        }
        await waitFor(() => expect(answerRequests).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(heldAnswerResponses).toHaveLength(1));
        await settleDuplicates();
        expect(callbackRequests()).toHaveLength(2);
        expectAdmissionConsumed();
      }
      if (heldMenuResponse) {
        sendResult(heldMenuResponse, menu);
        heldMenuResponse = undefined;
      }
      await monitor.waitForIdle();
      expect(downstream).toHaveBeenCalledOnce();

      const completedAnswerCount = callbackRequests().length;
      releaseAnswers = false;
      await monitor.admit(callbackUpdate);
      await waitFor(() => expect(heldAnswerResponses).toHaveLength(1));
      await settleDuplicates();
      await monitor.waitForIdle();
      expect(callbackRequests()).toHaveLength(completedAnswerCount + 1);
      expect(downstream).toHaveBeenCalledOnce();
      expectAdmissionConsumed();
    } finally {
      releaseAnswers = true;
      for (const response of heldAnswerResponses) {
        if (!response.writableEnded) {
          sendResult(response, true);
        }
      }
      if (heldMenuResponse && !heldMenuResponse.writableEnded) {
        sendResult(heldMenuResponse, menu);
      }
      await monitor?.waitForIdle();
      await monitor?.stop();
      await Promise.all(menuSyncs);
      menuSyncs.clear();
      readHandlerAnswer.mockRestore();
      clearRuntimeConfigSnapshot();
      clearTelegramRuntimeForTest();
      resetTelegramAccountThrottlersForTest();
      resetPluginStateStoreForTests({ closeDatabase: false });
      env.restore();
    }
    expect(runtimeErrors).toEqual([]);
    expect(downstream).toHaveBeenCalledOnce();
  },
);
