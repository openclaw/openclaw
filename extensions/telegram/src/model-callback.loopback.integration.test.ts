// A real grammY bot and HTTP Bot API prove model callbacks across the active router.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  mockPublishedModelRuntimeForTest,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getSessionEntryAsync,
  listSessionEntries,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { buildModelsKeyboard } from "./model-buttons.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

const TOKEN = "123456:loopback-token";
const CHAT_ID = 1234;
const PROVIDER = "ollama";
const MODEL = "xentriom/gemma-4-12B-agentic-fable5-composer2.5-v2:latest";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-model-loopback-");

type TelegramApiRequest = { method: string; payload: Record<string, unknown> };

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, result: unknown): void {
  // Same-process model selection can stall past the loopback socket's idle timeout.
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ ok: true, result }));
}

describe("Telegram model callback loopback", () => {
  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    resetPluginRuntimeStateForTest();
  });

  it("browses prepared model routes and persists a selected opaque callback over HTTP", async () => {
    const stateDir = sessionDirs.make();
    const requests: TelegramApiRequest[] = [];
    let sentMessage: Record<string, unknown> | undefined;

    const handleApiRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.url?.split("/").at(-1) ?? "";
      const payload = await readJsonBody(request);
      requests.push({ method, payload });

      if (method === "sendMessage") {
        const replyMarkup = payload.reply_markup as
          | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
          | undefined;
        for (const button of replyMarkup?.inline_keyboard?.flat() ?? []) {
          if (
            typeof button.callback_data !== "string" ||
            Buffer.byteLength(button.callback_data, "utf8") > 64
          ) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ ok: false, error_code: 400, description: "BUTTON_DATA_INVALID" }),
            );
            return;
          }
        }
        sentMessage = {
          message_id: 88,
          date: 1_786_404_800,
          chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
          from: telegramBotInfoForTest,
          text: payload.text,
          reply_markup: replyMarkup,
        };
        sendJson(response, sentMessage);
      } else if (method === "answerCallbackQuery") {
        sendJson(response, true);
      } else if (method === "editMessageText") {
        sentMessage = {
          ...sentMessage,
          text: payload.text,
          reply_markup: payload.reply_markup,
        };
        sendJson(response, sentMessage);
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error_code: 404, description: method }));
      }
    };

    const server = createServer((request, response) => {
      void handleApiRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const storePath = join(stateDir, "sessions.json");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
              [`${PROVIDER}/${MODEL}`]: {},
            },
          },
        },
        channels: {
          telegram: { apiRoot, botToken: TOKEN, dmPolicy: "open", allowFrom: ["*"] },
        },
        session: { store: storePath },
      };
      const registry = createEmptyPluginRegistry();
      registry.cliBackends.push({
        pluginId: "anthropic",
        source: "fixture",
        backend: {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "unused-fixture-cli" },
        },
      });
      setActivePluginRegistry(registry);
      const catalog = [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
        { provider: "claude-cli", id: "claude-opus-4-6", name: "Claude Opus (CLI)" },
        { provider: PROVIDER, id: MODEL, name: MODEL, api: "ollama" as const },
      ];
      // Only external prepared inventory/auth facts are fixed. The catalog decisions,
      // provider grouping, callbacks, serialization and session selection stay real.
      await mockPublishedModelRuntimeForTest({
        config,
        facts: {
          authModes: { "claude-cli": "api_key" },
          modelCatalog: { entries: catalog, routeVariants: catalog },
        },
        paths: { agentDir: join(stateDir, "agent"), workspaceDir: stateDir },
        authStore: {
          version: 1,
          profiles: Object.fromEntries(
            ["anthropic", "claude-cli", PROVIDER].map((provider) => [
              provider,
              { type: "api_key" as const, provider, key: "synthetic-key" },
            ]),
          ),
        },
      });
      await sendMessageTelegram(String(CHAT_ID), "Browse models:", {
        cfg: config,
        token: TOKEN,
        buttons: [[{ text: "Browse providers", callback_data: "mdl_prov" }]],
      });

      const callbackSteps: string[] = [];
      const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
      const telegramDeps = {
        ...defaultTelegramBotDeps,
        buildModelsProviderData: async (
          ...args: Parameters<TelegramBotDeps["buildModelsProviderData"]>
        ) => {
          callbackSteps.push("catalog");
          return defaultTelegramBotDeps.buildModelsProviderData(...args);
        },
        getRuntimeConfig: () => config,
      };
      const authorization = {
        resolveTelegramEventAuthorizationContext: async () => {
          callbackSteps.push("context");
          return {
            threadSpec: { scope: "none" },
            dmThreadId: undefined,
            storeAllowFrom: [],
            groupConfig: undefined,
          };
        },
        authorizeTelegramEventSender: async () => {
          callbackSteps.push("sender");
          return true;
        },
        isTelegramModelCallbackAuthorized: async () => {
          callbackSteps.push("model");
          return true;
        },
      } as unknown as TelegramHandlerAuthorization;
      const message = {
        processMessageWithReplyChain: async () => {
          throw new Error("model callback must not enter generic callback dispatch");
        },
        resolveTelegramSessionState: async () => {
          const sessionKey = "agent:main:telegram:direct:1234";
          return {
            agentId: "main",
            bindingMode: { kind: "none" },
            sessionEntry: await getSessionEntryAsync({ agentId: "main", sessionKey, storePath }),
            sessionKey,
            storePath,
            model: undefined,
          };
        },
      } as unknown as TelegramCallbackMessageRuntime;
      const router = createTelegramCallbackRouter({
        params: {
          accountId: "default",
          bot,
          runtime: {},
          telegramDeps,
          shouldSkipUpdate: () => false,
        } as unknown as RegisterTelegramHandlerParams,
        message,
        authorization,
      });
      bot.on("callback_query", async (context) => {
        await router.route(context);
      });
      let updateId = 0;
      const tap = (data: string) =>
        bot.handleUpdate({
          update_id: ++updateId,
          callback_query: {
            id: `loopback-callback-${updateId}`,
            chat_instance: "loopback-chat",
            data,
            from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
            message: sentMessage as never,
          },
        });
      const renderedButtons = () =>
        (
          sentMessage?.reply_markup as {
            inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
          }
        )?.inline_keyboard?.flat() ?? [];

      await tap("mdl_prov");
      expect(renderedButtons().map((button) => button.text)).toEqual([
        "anthropic (1)",
        "ollama (1)",
      ]);
      const providerButton = renderedButtons().find((button) => button.text === "ollama (1)");
      expect(providerButton).toBeDefined();
      await tap(providerButton!.callback_data);
      const modelButton = renderedButtons().find((button) =>
        button.callback_data.startsWith("mdl1~m:"),
      );
      expect(modelButton?.callback_data).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);
      expect(Buffer.byteLength(modelButton?.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
      await tap(modelButton!.callback_data);

      expect(requests.map(({ method }) => method)).toEqual([
        "sendMessage",
        "answerCallbackQuery",
        "editMessageText",
        "answerCallbackQuery",
        "editMessageText",
        "answerCallbackQuery",
        "editMessageText",
      ]);
      expect(callbackSteps).toEqual(
        Array(3).fill(["context", "sender", "model", "catalog"]).flat(),
      );
      expect(listSessionEntries({ storePath })[0]?.entry).toMatchObject({
        providerOverride: PROVIDER,
        modelOverride: MODEL,
        modelOverrideSource: "user",
        liveModelSwitchPending: true,
      });
      expect(requests.at(-1)?.payload.text).toContain(
        `Model changed to <b>${PROVIDER}/${MODEL}</b>`,
      );
    } finally {
      server.close();
      server.closeAllConnections();
      server.unref();
    }
  });

  it("clears stale buttons through the live router when a media callback message can't be edited or deleted", async () => {
    const stateDir = sessionDirs.make();
    const requests: TelegramApiRequest[] = [];
    const mediaMessage: Record<string, unknown> = {
      message_id: 99,
      date: 1_786_404_800,
      chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
      from: telegramBotInfoForTest,
      caption: "Select a model:",
    };

    const handleApiRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const method = request.url?.split("/").at(-1) ?? "";
      const payload = await readJsonBody(request);
      requests.push({ method, payload });

      if (method === "answerCallbackQuery") {
        sendJson(response, true);
      } else if (method === "editMessageText") {
        // The original message is media (caption, no text), exactly as Telegram
        // rejects it when the Bot API has no text body to replace.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: there is no text in the message to edit",
          }),
        );
      } else if (method === "deleteMessage") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message can't be deleted",
          }),
        );
      } else if (method === "editMessageReplyMarkup") {
        sendJson(response, { ...mediaMessage, reply_markup: payload.reply_markup });
      } else if (method === "sendMessage") {
        sendJson(response, {
          message_id: 100,
          date: 1_786_404_801,
          chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
          from: telegramBotInfoForTest,
          text: payload.text,
        });
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error_code: 404, description: method }));
      }
    };

    const server = createServer((request, response) => {
      void handleApiRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const storePath = join(stateDir, "sessions.json");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              [`${PROVIDER}/${MODEL}`]: {},
            },
          },
        },
        channels: {
          telegram: { apiRoot, botToken: TOKEN, dmPolicy: "open", allowFrom: ["*"] },
        },
        session: { store: storePath },
      };
      const buttons = buildModelsKeyboard({
        provider: PROVIDER,
        models: [MODEL],
        currentPage: 1,
        totalPages: 1,
      });
      const callbackData = buttons?.[0]?.[0]?.callback_data;
      expect(callbackData).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);

      const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
      const telegramDeps = {
        ...defaultTelegramBotDeps,
        buildModelsProviderData: async (): ReturnType<
          TelegramBotDeps["buildModelsProviderData"]
        > => ({
          byProvider: new Map([
            ["anthropic", new Set(["claude-opus-4-6"])],
            [PROVIDER, new Set([MODEL])],
          ]),
          providers: ["anthropic", PROVIDER],
          resolvedDefault: { provider: "anthropic", model: "claude-opus-4-6" },
          modelNames: new Map<string, string>(),
          modelCatalog: [
            {
              provider: PROVIDER,
              id: MODEL,
              name: MODEL,
              api: "ollama",
              contextWindow: 32_768,
              reasoning: true,
            },
          ],
        }),
        getRuntimeConfig: () => config,
      };
      const authorization = {
        resolveTelegramEventAuthorizationContext: async () => ({
          threadSpec: { scope: "none" },
          dmThreadId: undefined,
          storeAllowFrom: [],
          groupConfig: undefined,
        }),
        authorizeTelegramEventSender: async () => true,
        isTelegramModelCallbackAuthorized: async () => true,
      } as unknown as TelegramHandlerAuthorization;
      const message = {
        processMessageWithReplyChain: async () => {
          throw new Error("model callback must not enter generic callback dispatch");
        },
        resolveTelegramSessionState: async () => ({
          agentId: "main",
          sessionEntry: undefined,
          sessionKey: "agent:main:telegram:direct:1234:media",
          storePath,
          model: undefined,
        }),
      } as unknown as TelegramCallbackMessageRuntime;
      const router = createTelegramCallbackRouter({
        params: {
          accountId: "default",
          bot,
          runtime: {},
          telegramDeps,
          shouldSkipUpdate: () => false,
        } as unknown as RegisterTelegramHandlerParams,
        message,
        authorization,
      });
      bot.on("callback_query", async (context) => {
        await router.route(context);
      });
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "loopback-callback-media",
          chat_instance: "loopback-chat-media",
          data: callbackData,
          from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
          message: mediaMessage as never,
        },
      });

      // The handler must clear the stale inline keyboard on the undeletable media
      // message before the replacement confirmation is sent, so a tapper never sees
      // live buttons sitting next to the new text.
      expect(requests.map(({ method }) => method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
        "deleteMessage",
        "editMessageReplyMarkup",
        "sendMessage",
      ]);
      expect(requests[3]?.payload).toMatchObject({
        chat_id: CHAT_ID,
        message_id: 99,
        reply_markup: { inline_keyboard: [] },
      });
      const clearButtonsIndex = requests.findIndex(
        ({ method }) => method === "editMessageReplyMarkup",
      );
      const sendMessageIndex = requests.findIndex(({ method }) => method === "sendMessage");
      expect(clearButtonsIndex).toBeGreaterThanOrEqual(0);
      expect(sendMessageIndex).toBeGreaterThan(clearButtonsIndex);
      expect(requests.at(-1)?.payload.text).toContain(
        `Model changed to <b>${PROVIDER}/${MODEL}</b>`,
      );
    } finally {
      server.close();
      server.closeAllConnections();
      server.unref();
    }
  });
});
