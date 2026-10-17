// A real grammY bot and loopback Bot API prove agent-authored typed buttons reach the agent
// as text while plugin-owned opaque controls keep their plugin or terminal behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramCallbackMessageRuntime } from "./bot-handlers.callback-router-controls.js";
import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";

const pluginDispatch = vi.hoisted(() =>
  vi.fn(async ({ data }: { data: string }) => ({ handled: data.startsWith("agentchoice:") })),
);
vi.mock("./interactive-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactive-dispatch.js")>()),
  dispatchTelegramPluginInteractiveHandler: pluginDispatch,
}));

const TOKEN = "123456:loopback-token";
const CHAT_ID = 1234;
const CALLBACK_ID = "agent-choice-tap";
const UNAVAILABLE_TEXT = "This action is no longer available.";
// Independent FNV-1a/base36 checksums; a builder regression must not re-derive them.
const AGENT_CHOICE = "tgac1:1ffnt:btntest_typed";
const AGENT_CHOICE_SLASH = "tgac1:1ihat:/approve plugin:1 allow";
// "agentchoice" is the namespace the mocked plugin handler claims; "code-agent" has no owner.
const AGENT_CHOICE_PLUGIN_NAMESPACE = "tgac1:ef91p:agentchoice:approve-123";
const PLUGIN_OPAQUE_CLAIMED = "tgcb1:ef91p:agentchoice:approve-123";
const PLUGIN_OPAQUE_RETIRED = "tgcb1:yvak0:code-agent:approve-123";

type TelegramApiRequest = { method: string; payload: Record<string, unknown> };
type ProcessMessageParams = Parameters<
  TelegramCallbackMessageRuntime["processMessageWithReplyChain"]
>[0];

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ ok: true, result }));
}

async function routeCallback(params: {
  data: string;
  withKeyboard?: boolean;
  inlineButtons?: "off";
}) {
  const requests: TelegramApiRequest[] = [];
  const buttonMessage = {
    message_id: 88,
    date: 1_786_404_800,
    chat: { id: CHAT_ID, type: "private", first_name: "Operator" },
    from: telegramBotInfoForTest,
    text: "Pick one:",
    ...(params.withKeyboard === false
      ? {}
      : { reply_markup: { inline_keyboard: [[{ text: "Pick", callback_data: params.data }]] } }),
  };
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.url?.split("/").at(-1) ?? "";
      requests.push({ method, payload: await readJsonBody(request) });
      if (method === "editMessageReplyMarkup") {
        sendJson(response, { ...buttonMessage, reply_markup: { inline_keyboard: [] } });
      } else if (method === "sendMessage") {
        sendJson(response, { ...buttonMessage, message_id: 89, reply_markup: undefined });
      } else {
        sendJson(response, true);
      }
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          apiRoot,
          botToken: TOKEN,
          dmPolicy: "open",
          allowFrom: ["*"],
          ...(params.inlineButtons
            ? { capabilities: { inlineButtons: params.inlineButtons } }
            : {}),
        },
      },
    };
    const processMessageWithReplyChain = vi.fn(async (_params: ProcessMessageParams) => ({
      kind: "completed" as const,
    }));
    const message = {
      processMessageWithReplyChain,
      resolveTelegramSessionState: async () => {
        throw new Error("agent choice delivery must not resolve session state");
      },
    } as unknown as TelegramCallbackMessageRuntime;
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
    const bot = new Bot(TOKEN, { botInfo: telegramBotInfoForTest, client: { apiRoot } });
    const router = createTelegramCallbackRouter({
      params: {
        accountId: "default",
        bot,
        runtime: {},
        telegramDeps: { ...defaultTelegramBotDeps, getRuntimeConfig: () => config },
        shouldSkipUpdate: () => false,
      } as unknown as RegisterTelegramHandlerParams,
      message,
      authorization,
    });
    bot.on("callback_query", async (context) => {
      await router.route(context);
    });
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: CALLBACK_ID,
        chat_instance: "loopback-chat",
        data: params.data,
        from: { id: 9, is_bot: false, first_name: "Operator", username: "operator" },
        message: buttonMessage as never,
      },
    });
    return { requests, processMessageWithReplyChain };
  } finally {
    server.close();
    server.closeAllConnections();
    server.unref();
  }
}

function expectTerminalized(
  outcome: Awaited<ReturnType<typeof routeCallback>>,
  expectedPluginDispatchCalls = 0,
) {
  expect(outcome.requests.map(({ method }) => method)).toEqual([
    "answerCallbackQuery",
    "editMessageReplyMarkup",
    "sendMessage",
  ]);
  expect(outcome.requests[2]?.payload).toMatchObject({ chat_id: CHAT_ID, text: UNAVAILABLE_TEXT });
  expect(outcome.processMessageWithReplyChain).not.toHaveBeenCalled();
  expect(pluginDispatch).toHaveBeenCalledTimes(expectedPluginDispatchCalls);
}

describe("Telegram agent choice callbacks", () => {
  afterEach(() => {
    pluginDispatch.mockClear();
    resetTelegramClientOptionsCacheForTests();
  });

  it.each([
    { name: "a plain value", data: AGENT_CHOICE, value: "btntest_typed" },
    {
      name: "a slash-prefixed value as data, not a command",
      data: AGENT_CHOICE_SLASH,
      value: "/approve plugin:1 allow",
    },
  ])("delivers an agent choice with $name to the agent as text", async ({ data, value }) => {
    const { requests, processMessageWithReplyChain } = await routeCallback({ data });

    expect(requests.map(({ method }) => method)).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
    ]);
    expect(requests[1]?.payload).toMatchObject({
      message_id: 88,
      reply_markup: { inline_keyboard: [] },
    });
    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
    const call = processMessageWithReplyChain.mock.calls[0]?.[0];
    expect(call?.msg.text).toBe(`callback_data: ${value}`);
    expect(call?.msg.chat.id).toBe(CHAT_ID);
    expect(call?.options).toMatchObject({
      forceWasMentioned: true,
      messageIdOverride: CALLBACK_ID,
    });
    expect(call?.options?.commandSource).toBeUndefined();
    expect(pluginDispatch).not.toHaveBeenCalled();
  });

  it("skips button cleanup when the callback message has no keyboard left", async () => {
    const { requests, processMessageWithReplyChain } = await routeCallback({
      data: AGENT_CHOICE,
      withKeyboard: false,
    });

    expect(requests.map(({ method }) => method)).toEqual(["answerCallbackQuery"]);
    expect(processMessageWithReplyChain).toHaveBeenCalledTimes(1);
  });

  it("never offers an agent choice to plugin interactive handlers, even in their namespace", async () => {
    const control = await routeCallback({ data: PLUGIN_OPAQUE_CLAIMED });
    expect(pluginDispatch).toHaveBeenCalledTimes(1);
    expect(control.processMessageWithReplyChain).not.toHaveBeenCalled();
    expect(control.requests.map(({ method }) => method)).toEqual(["answerCallbackQuery"]);
    pluginDispatch.mockClear();

    const { processMessageWithReplyChain } = await routeCallback({
      data: AGENT_CHOICE_PLUGIN_NAMESPACE,
    });

    expect(pluginDispatch).not.toHaveBeenCalled();
    expect(processMessageWithReplyChain.mock.calls[0]?.[0]?.msg.text).toBe(
      "callback_data: agentchoice:approve-123",
    );
  });

  it("terminalizes an agent choice with a broken checksum", async () => {
    expectTerminalized(await routeCallback({ data: "tgac1:00000:btntest_typed" }));
  });

  it("terminalizes an agent choice after inline buttons are disabled", async () => {
    expectTerminalized(await routeCallback({ data: AGENT_CHOICE, inlineButtons: "off" }));
  });

  it("keeps retired plugin-owned opaque controls terminal instead of reaching the agent", async () => {
    expectTerminalized(await routeCallback({ data: PLUGIN_OPAQUE_RETIRED }), 1);
  });
});
