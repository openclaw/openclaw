// Real grammY ingress and Bot API sockets: stalled forum metadata must not block delivery.
import { Bot } from "grammy";
import type { Chat } from "grammy/types";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundPipeline,
  registerTelegramInboundHandlers,
} from "./bot-handlers.inbound-pipeline.js";
import {
  createTelegramMessagePipeline,
  type TelegramMessagePipeline,
} from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { createTelegramIngressResolver } from "./ingress.js";
import * as telegramRequestTimeouts from "./request-timeouts.js";
import { setTelegramRuntime } from "./runtime.js";

function update(update_id: number, chat: Chat, senderId: number) {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 1_700_000_000,
      chat,
      from: { id: senderId, is_bot: false, first_name: "Sender" },
      text: "message",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("dispatches DMs immediately and the supergroup after cancelling its stalled socket", async () => {
  setTelegramRuntime(createPluginRuntimeMock());
  let getChatRequests = 0;
  const headersReceived = createDeferred<void>();
  const socketClosed = createDeferred<void>();
  await withServer(
    (request, response) => {
      if (!request.url?.endsWith("/getChat")) {
        response.writeHead(404);
        response.end();
        return;
      }
      getChatRequests += 1;
      request.socket.once("close", () => socketClosed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,"result":{"id":-100364');
    },
    async (apiRoot) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const canonicalRequestTimeout = telegramRequestTimeouts.resolveTelegramRequestTimeoutMs;
      vi.spyOn(telegramRequestTimeouts, "resolveTelegramRequestTimeoutMs").mockImplementation(
        (method, configuredTimeoutSeconds) =>
          method === "getchat" ? 100 : canonicalRequestTimeout(method, configuredTimeoutSeconds),
      );

      const clientFetch = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(globalThis.fetch),
      });
      if (!clientFetch) {
        throw new Error("expected production Telegram client fetch wrapper");
      }
      const observeClientFetch: typeof clientFetch = async (input, init) => {
        const response = await clientFetch(input, init);
        headersReceived.resolve();
        return response;
      };
      const botInfo = telegramBotInfoForTest;
      const bot = new Bot("123456:integration-token", {
        botInfo,
        client: { apiRoot, fetch: asTelegramClientFetch(observeClientFetch) },
      });
      const dispatched = vi.fn<TelegramMessagePipeline["processMessageWithReplyChain"]>(
        async () => ({
          kind: "completed",
        }),
      );
      const emptyAllow = {
        entries: [],
        hasWildcard: false,
        hasEntries: false,
        invalidEntries: [],
      };
      const params: RegisterTelegramHandlerParams = {
        accountId: "default",
        ownerAgentId: "main",
        bot,
        cfg: { messages: { inbound: { debounceMs: 0 } } },
        mediaMaxBytes: 1,
        opts: { token: "123456:integration-token", botInfo },
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
        telegramCfg: {},
        logger: getChildLogger({ module: "telegram/forum-ingress-test" }),
        resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
        resolveGroupActivation: () => undefined,
        resolveGroupRequireMention: () => false,
        resolveTelegramGroupConfig: () => ({}),
        shouldSkipUpdate: () => false,
        processMessage: async () => ({ kind: "completed" }),
      };
      const authorizeInboundMessage = vi.fn<
        ReturnType<typeof createTelegramHandlerAuthorization>["authorizeInboundMessage"]
      >(async (inbound) => {
        const resolver = createTelegramIngressResolver({ accountId: "default" });
        return {
          allowed: true as const,
          resolveChannelIngress: async (contextBinding) =>
            await resolver.message({
              subject: { stableId: inbound.senderId },
              conversation: {
                kind: inbound.isGroup ? "group" : "direct",
                id: String(inbound.chatId),
              },
              contextBinding,
              dmPolicy: "open",
              groupPolicy: "open",
            }),
          effectiveDmAllow: emptyAllow,
          context: {
            commandAuthorizedByConfig: false,
            cfg: params.cfg,
            telegramCfg: {},
            allowFrom: [],
            dmPolicy: "open" as const,
            threadSpec: inbound.isGroup ? ({ scope: "none" } as const) : ({ scope: "dm" } as const),
            storeAllowFrom: [],
            effectiveGroupAllow: emptyAllow,
            hasGroupAllowOverride: false,
          },
        };
      });
      const authorization = {
        ...createTelegramHandlerAuthorization(params),
        authorizeInboundMessage,
      };
      const message: TelegramMessagePipeline = {
        ...createTelegramMessagePipeline(params),
        releaseDispatchDedupeClaims: () => undefined,
        claimMessageDispatchDedupe: async () => ({ process: true, claims: [] }),
        resolveTelegramSessionState: async () => ({
          agentId: "integration",
          bindingMode: { kind: "none" as const },
          sessionEntry: undefined,
          sessionKey: "integration",
          storePath: "integration",
          model: undefined,
        }),
        resolvePromptContextAmbientWatermark: async () => undefined,
        recordMessageForReplyChain: async (msg) => ({
          messageId: String(msg.message_id),
          sender: "integration sender",
          sourceMessage: msg,
        }),
        processMessageWithReplyChain: dispatched,
      };
      const pipeline = createTelegramInboundPipeline({ params, message, authorization });
      registerTelegramInboundHandlers({ bot, pipeline });

      const groupDelivery = bot.handleUpdate(
        update(1, { id: -100364, type: "supergroup", title: "Integration group" }, 111),
      );
      void groupDelivery.catch(() => undefined);
      // The client must receive headers before the deadline advances: the regression
      // cleared the deadline after fetch resolved, leaving body consumption unbounded.
      await Promise.race([
        headersReceived.promise,
        groupDelivery.then(() => {
          throw new Error("group delivery settled before the metadata response headers");
        }),
      ]);

      await bot.handleUpdate(update(2, { id: 222, type: "private", first_name: "DM sender" }, 222));
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(dispatched.mock.calls[0]?.[0].msg.chat.id).toBe(222);
      expect(authorizeInboundMessage.mock.calls[0]?.[0]).toMatchObject({
        chatId: 222,
        isGroup: false,
        isForum: false,
      });

      const groupResult = Promise.race([
        groupDelivery.then(() => "dispatched" as const),
        new Promise<"stalled">((resolve) => {
          setTimeout(() => resolve("stalled"), 1_000);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await groupResult).toBe("dispatched");
      expect(dispatched).toHaveBeenCalledTimes(2);
      expect(dispatched.mock.calls[1]?.[0].msg.chat.id).toBe(-100364);
      expect(authorizeInboundMessage.mock.calls[1]?.[0]).toMatchObject({
        chatId: -100364,
        isGroup: true,
        isForum: false,
      });
      expect(getChatRequests).toBe(1);
      await socketClosed.promise;
    },
  );
});
