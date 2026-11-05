import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buffer as consumeBuffer } from "node:stream/consumers";
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
  listSessionEntriesAsync,
} from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
const callbackMocks = vi.hoisted(() => ({
  getRuntimeConfig:
    vi.fn<typeof import("openclaw/plugin-sdk/runtime-config-snapshot").readRuntimeConfig>(),
  buildModelsProviderData:
    vi.fn<
      typeof import("openclaw/plugin-sdk/models-provider-runtime").buildPreparedModelsProviderData
    >(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: callbackMocks.getRuntimeConfig,
}));
vi.mock("openclaw/plugin-sdk/models-provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/models-provider-runtime")>()),
  buildPreparedModelsProviderData: callbackMocks.buildModelsProviderData,
}));

type TelegramApiRequest = { method: string; payload: Record<string, unknown> };

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await consumeBuffer(request)).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, result: unknown): void {
  // Same-process model selection can stall past the loopback socket's idle timeout.
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ ok: true, result }));
}

function sendError(response: ServerResponse, code: number, description: string) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error_code: code, description }));
}

function modelButtons() {
  return buildModelsKeyboard({
    provider: PROVIDER,
    models: [MODEL],
    currentPage: 1,
    totalPages: 1,
  });
}

function telegramMessage(message_id: number, content: Record<string, unknown>) {
  return {
    message_id,
    date: 1_786_404_800 + (message_id === 100 ? 1 : 0),
    chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
    from: telegramBotInfoForTest,
    ...content,
  };
}

async function tapModel(
  bot: Bot,
  data: string | undefined,
  message: Record<string, unknown>,
  media = false,
) {
  const suffix = media ? "-media" : "";
  await bot.handleUpdate({
    update_id: media ? 2 : 1,
    callback_query: {
      id: `loopback-callback${suffix}`,
      chat_instance: `loopback-chat${suffix}`,
      data,
      from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
      message: message as never,
    },
  });
}

async function withApi(
  handler: (method: string, payload: Record<string, unknown>, response: ServerResponse) => void,
  run: (apiRoot: string, requests: TelegramApiRequest[]) => Promise<void>,
) {
  const requests: TelegramApiRequest[] = [];
  const server = createServer((request, response) => {
    void readJsonBody(request)
      .then((payload) => {
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, payload });
        handler(method, payload, response);
      })
      .catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    server.close();
    server.closeAllConnections();
    server.unref();
  }
}

function configureRouter(apiRoot: string, storePath: string, steps: string[] = [], media = false) {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        models: { "anthropic/claude-opus-4-6": {}, [`${PROVIDER}/${MODEL}`]: {} },
      },
    },
    channels: { telegram: { apiRoot, botToken: TOKEN, dmPolicy: "open", allowFrom: ["*"] } },
    session: { store: storePath },
  };
  callbackMocks.getRuntimeConfig.mockReturnValue(config);
  callbackMocks.buildModelsProviderData.mockImplementation(async () => {
    steps.push("catalog");
    return {
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
    };
  });
  const authorization = {
    resolveTelegramEventAuthorizationContext: async () => {
      steps.push("context");
      return {
        threadSpec: { scope: "none" },
        dmThreadId: undefined,
        storeAllowFrom: [],
        groupConfig: undefined,
      };
    },
    authorizeTelegramEventSender: async () => {
      steps.push("sender");
      return true;
    },
    isTelegramModelCallbackAuthorized: async () => {
      steps.push("model");
      return true;
    },
  } as unknown as TelegramHandlerAuthorization;
  const message = {
    processMessageWithReplyChain: async () => {
      throw new Error("model callback must not enter generic callback dispatch");
    },
    resolveTelegramSessionState: async () => {
      const sessionKey = `agent:main:telegram:direct:1234${media ? ":media" : ""}`;
      return {
        agentId: "main",
        ...(media ? {} : { bindingMode: { kind: "none" } }),
        sessionEntry: await getSessionEntryAsync({ agentId: "main", sessionKey, storePath }),
        sessionKey,
        storePath,
        model: undefined,
      };
    },
  } as unknown as TelegramCallbackMessageRuntime;
  const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
  const router = createTelegramCallbackRouter({
    params: {
      accountId: "default",
      bot,
      runtime: {},
      shouldSkipUpdate: () => false,
    } as unknown as RegisterTelegramHandlerParams,
    message,
    authorization,
  });
  bot.on("callback_query", async (context) => {
    await router.route(context);
  });
  return { config, bot };
}

describe("Telegram model callback loopback", () => {
  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    resetPluginRuntimeStateForTest();
  });

  it("browses equivalent routes and selects the retained runtime and an opaque model over HTTP", async () => {
    const stateDir = sessionDirs.make();
    let sentMessage: Record<string, unknown> | undefined;
    await withApi(
      (method, payload, response) => {
        if (method === "sendMessage") {
          const replyMarkup = payload.reply_markup as
            | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
            | undefined;
          for (const button of replyMarkup?.inline_keyboard?.flat() ?? []) {
            if (
              typeof button.callback_data !== "string" ||
              Buffer.byteLength(button.callback_data, "utf8") > 64
            ) {
              sendError(response, 400, "BUTTON_DATA_INVALID");
              return;
            }
          }
          sentMessage = telegramMessage(88, {
            text: payload.text,
            reply_markup: replyMarkup,
          });
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
          sendError(response, 404, method);
        }
      },
      async (apiRoot, requests) => {
        const storePath = join(stateDir, "sessions.json");
        const callbackSteps: string[] = [];
        const { config, bot } = configureRouter(apiRoot, storePath, callbackSteps);
        config.agents = {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
              [`${PROVIDER}/${MODEL}`]: {},
            },
          },
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
        // Fix external inventory/auth facts; grouping, callback routing, HTTP and persistence stay real.
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
        const actual = await vi.importActual<
          typeof import("openclaw/plugin-sdk/models-provider-runtime")
        >("openclaw/plugin-sdk/models-provider-runtime");
        callbackMocks.buildModelsProviderData.mockImplementation(async (...args) => {
          callbackSteps.push("catalog");
          return actual.buildPreparedModelsProviderData(...args);
        });
        await sendMessageTelegram(String(CHAT_ID), "Browse models:", {
          cfg: config,
          token: TOKEN,
          buttons: [[{ text: "Browse providers", callback_data: "mdl_prov" }]],
        });

        let updateId = 0;
        const tap = async (data: string) => {
          if (!sentMessage) {
            throw new Error("Expected the sent model keyboard message");
          }
          await bot.handleUpdate({
            update_id: ++updateId,
            callback_query: {
              id: `loopback-callback-${updateId}`,
              chat_instance: "loopback-chat",
              data,
              from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
              message: sentMessage as never,
            },
          });
        };
        const renderedButtons = () =>
          (
            sentMessage?.reply_markup as {
              inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
            }
          )?.inline_keyboard?.flat() ?? [];
        const selectButton = async (
          predicate: (button: ReturnType<typeof renderedButtons>[number]) => boolean,
        ) => {
          const button = renderedButtons().find(predicate);
          expect(button).toBeDefined();
          await tap(button!.callback_data);
        };

        await tap("mdl_prov");
        expect(renderedButtons().map((button) => button.text)).toEqual([
          "anthropic (1)",
          "ollama (1)",
        ]);
        await selectButton((button) => button.text === "anthropic (1)");
        await selectButton((button) => button.text.includes("Claude Opus"));
        expect(requests.at(-1)?.payload.text).toContain(
          "Runtime set to <b>claude-cli</b> from configured policy.",
        );
        const defaultEntry = await getSessionEntryAsync({
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:1234",
          storePath,
        });
        expect(defaultEntry).toBeDefined();
        expect(defaultEntry?.modelOverride).toBeUndefined();
        expect(defaultEntry?.agentRuntimeOverride).toBeUndefined();

        await tap("mdl_prov");
        await selectButton((button) => button.text === "ollama (1)");
        const modelButton = renderedButtons().find((button) =>
          button.callback_data.startsWith("mdl1~m:"),
        );
        expect(modelButton?.callback_data).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);
        expect(Buffer.byteLength(modelButton?.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
        await tap(modelButton!.callback_data);

        expect(requests.map(({ method }) => method)).toEqual([
          "sendMessage",
          ...Array.from({ length: 6 }, () => ["answerCallbackQuery", "editMessageText"]).flat(),
        ]);
        // Compact callbacks cross generic-interactive and model auth; opaque refs skip generic dispatch.
        expect(callbackSteps).toEqual([
          ...Array.from({ length: 5 }, () => [
            "context",
            "sender",
            "model",
            "model",
            "catalog",
          ]).flat(),
          "context",
          "sender",
          "model",
          "catalog",
        ]);
        expect(
          (await listSessionEntriesAsync({ agentId: "main", storePath }))[0]?.entry,
        ).toMatchObject({
          providerOverride: PROVIDER,
          modelOverride: MODEL,
          modelOverrideSource: "user",
          liveModelSwitchPending: true,
        });
        expect(requests.at(-1)?.payload.text).toContain(
          `Model changed to <b>${PROVIDER}/${MODEL}</b>`,
        );
      },
    );
  });

  it("clears stale buttons through the live router when a media callback message can't be edited or deleted", async () => {
    const stateDir = sessionDirs.make();
    const mediaMessage = telegramMessage(99, { caption: "Select a model:" });

    await withApi(
      (method, payload, response) => {
        if (method === "answerCallbackQuery") {
          sendJson(response, true);
        } else if (method === "editMessageText") {
          sendError(response, 400, "Bad Request: there is no text in the message to edit");
        } else if (method === "deleteMessage") {
          sendError(response, 400, "Bad Request: message can't be deleted");
        } else if (method === "editMessageReplyMarkup") {
          sendJson(response, { ...mediaMessage, reply_markup: payload.reply_markup });
        } else if (method === "sendMessage") {
          sendJson(response, telegramMessage(100, { text: payload.text }));
        } else {
          sendError(response, 404, method);
        }
      },
      async (apiRoot, requests) => {
        const storePath = join(stateDir, "sessions.json");
        const { bot } = configureRouter(apiRoot, storePath, [], true);
        const buttons = modelButtons();
        const callbackData = buttons?.[0]?.[0]?.callback_data;
        expect(callbackData).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);

        await tapModel(bot, callbackData, mediaMessage, true);

        // Clear stale buttons before sending the replacement confirmation.
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
        expect(requests.at(-1)?.payload.text).toContain(
          `Model changed to <b>${PROVIDER}/${MODEL}</b>`,
        );
      },
    );
  });
});
