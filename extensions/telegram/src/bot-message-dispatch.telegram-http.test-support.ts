import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { AbortController as TelegramAbortController } from "abort-controller";
import { Bot } from "grammy";
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import * as transcriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
} from "./runtime.test-support.js";

type RecordedBotApiCall = { method: string; fields: Record<string, unknown> };
type ReplyResolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;
export type ReplyResolverOptions = Parameters<ReplyResolver>[1];
type DispatchParams = Parameters<typeof dispatchTelegramMessage>[0];
type DispatchScenario = {
  mode: DispatchParams["streamMode"];
  toolProgress: boolean;
  finalReply?: ReplyPayload | ReplyPayload[];
  producer?: NonNullable<Parameters<typeof dispatchInboundMessage>[0]["dispatchReplyFromConfig"]>;
  replyToMode?: DispatchParams["replyToMode"];
  accountId?: string;
  telegramCfg?: DispatchParams["telegramCfg"];
  cfg?: OpenClawConfig;
  onDispatch?: (cfg: OpenClawConfig) => void;
  context?: TelegramMessageContext;
  textLimit?: number;
  allowErrors?: boolean;
  outcome?: "completed" | "failed-retryable";
  turnAdoptionLifecycle?: DispatchParams["turnAdoptionLifecycle"];
  suppressFailureFallback?: boolean;
};

const BOT_TOKEN = "123456:telegram-progress-http-fixture";
const CHAT_ID = 123;
const MESSAGE_METHODS = new Set([
  "sendMessage",
  "sendRichMessage",
  "editMessageText",
  "sendDocument",
  "sendPhoto",
  "sendAudio",
  "sendVoice",
  "sendVideo",
]);
function respondJson(response: ServerResponse, result: unknown = true) {
  response.end(JSON.stringify({ ok: true, result }));
}
function rejectJson(response: ServerResponse, error: { error_code: number; description: string }) {
  response.writeHead(error.error_code).end(JSON.stringify({ ok: false, ...error }));
}

export function installTelegramDispatchHook(
  hook: Omit<Parameters<typeof addTestHook>[0], "registry" | "pluginId">,
  pluginId = "http-policy",
) {
  const registry = createEmptyPluginRegistry();
  addTestHook({ registry, pluginId, ...hook });
  initializeGlobalHookRunner(registry);
}

export function telegramReplyId(fields: Record<string, unknown>) {
  const reply = fields.reply_parameters;
  return reply && typeof reply === "object" && "message_id" in reply
    ? reply.message_id
    : fields.reply_to_message_id;
}

export function createTelegramDispatchHttpFixture() {
  let server: Server;
  let apiRoot: string;
  let state: OpenClawTestState;
  let bot: Bot;
  let nextMessageId = 0;
  let inboundSequence = 0;
  const calls: RecordedBotApiCall[] = [];
  const endpoints: string[] = [];
  const visibleMessages = new Map<number, string>();
  const visibleMarkup = new Map<number, unknown>();
  const acceptedCalls: RecordedBotApiCall[] = [];
  const botApiCalls = new EventTarget();
  const completedCalls = new WeakSet<RecordedBotApiCall>();
  const pendingDeletes: Promise<unknown>[] = [];
  let typingSend: Promise<void> = Promise.resolve();
  let lifetime: AbortController;
  let stopped: ReturnType<typeof createDeferred<never>>;
  const pendingDispatches = new Set<Promise<unknown>>();
  const pendingTranscriptMirrors: Promise<unknown>[] = [];
  let restoreTranscriptMirror: () => void;
  const bindingAdapters = new Map<string, SessionBindingAdapter>();
  const pendingRequests = new Set<Promise<unknown>>();
  type Rejection =
    | { error_code: number; description: string; parameters?: { retry_after?: number } }
    | "no-message-id"
    | undefined;
  let respondToCall: ((call: RecordedBotApiCall) => Rejection | Promise<Rejection>) | undefined;
  let rejectNextQuote = false;
  let holdNextCall:
    | {
        predicate: (call: RecordedBotApiCall) => boolean;
        arrived: { resolve: () => void };
        release: { promise: Promise<void> };
      }
    | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const respond = async () => {
        const body = await buffer(request);
        const contentType = request.headers["content-type"] ?? "application/json";
        const fields: Record<string, unknown> = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Response(body, { headers: { "content-type": contentType } }).formData(),
            )
          : contentType.includes("application/json")
            ? JSON.parse(body.toString("utf8"))
            : Object.fromEntries(new URLSearchParams(body.toString("utf8")));
        for (const key of ["reply_parameters", "reply_markup"]) {
          if (typeof fields[key] === "string") {
            fields[key] = JSON.parse(fields[key]);
          }
        }
        const method = request.url?.split("/").at(-1) ?? "";
        const call = { method, fields };
        endpoints.push(request.url ?? "");
        calls.push(call);
        response.once("finish", () => {
          completedCalls.add(call);
          botApiCalls.dispatchEvent(new Event("call"));
        });
        const held = holdNextCall;
        if (held?.predicate(call)) {
          holdNextCall = undefined;
          held.arrived.resolve();
          await Promise.race([held.release.promise, stopped.promise]);
        }
        response.setHeader("content-type", "application/json");
        // Idle keep-alive expiry must not race later fixture requests under load.
        response.setHeader("connection", "close");
        const rejection = await Promise.race([
          Promise.resolve(respondToCall?.(call)),
          stopped.promise,
        ]);
        if (rejection) {
          if (rejection === "no-message-id") {
            respondJson(response);
          } else {
            rejectJson(response, rejection);
          }
          return;
        }
        if (
          method === "sendMessage" &&
          rejectNextQuote &&
          fields.reply_parameters &&
          typeof fields.reply_parameters === "object" &&
          "quote" in fields.reply_parameters
        ) {
          rejectNextQuote = false;
          rejectJson(response, { error_code: 400, description: "Bad Request: quote not found" });
          return;
        }
        acceptedCalls.push(call);
        const chatId = Number(fields.chat_id ?? CHAT_ID);
        const chat =
          chatId < 0
            ? {
                id: chatId,
                type: "supergroup",
                title: "Fixture group",
                ...(fields.message_thread_id ? { is_forum: true } : {}),
              }
            : { id: chatId, type: "private", first_name: "Fixture" };
        if (method === "getChat") {
          respondJson(response, chat);
          return;
        }
        if (MESSAGE_METHODS.has(method)) {
          const messageId =
            fields.message_id === undefined ? ++nextMessageId : Number(fields.message_id);
          const caption = fields.caption;
          if (caption !== undefined && typeof caption !== "string") {
            throw new Error("Expected a string Telegram caption");
          }
          const text =
            typeof fields.text === "string"
              ? fields.text
              : fields.rich_message
                ? JSON.stringify(fields.rich_message)
                : (caption ?? "");
          visibleMessages.set(messageId, text);
          if (fields.reply_markup !== undefined) {
            visibleMarkup.set(messageId, fields.reply_markup);
          }
          respondJson(response, {
            message_id: messageId,
            date: 1_700_000_000,
            chat,
            text,
            ...(caption === undefined ? {} : { caption }),
            ...(fields.message_thread_id
              ? { message_thread_id: Number(fields.message_thread_id) }
              : {}),
          });
          return;
        }
        if (method === "editMessageReplyMarkup") {
          visibleMarkup.set(Number(fields.message_id), fields.reply_markup);
        }
        if (method === "deleteMessage") {
          visibleMessages.delete(Number(fields.message_id));
          visibleMarkup.delete(Number(fields.message_id));
        }
        respondJson(response);
      };
      void respond().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    // The fixture owns a loopback Bot API; inherited host proxies must not intercept it.
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost,::1");
    vi.stubEnv("no_proxy", "127.0.0.1,localhost,::1");
    state = await createOpenClawTestState({ label: "telegram-dispatch-http" });
    const append = transcriptRuntime.appendAssistantMirrorMessageByIdentity;
    const observer = vi
      .spyOn(transcriptRuntime, "appendAssistantMirrorMessageByIdentity")
      .mockImplementation((params) => {
        const pending = append(params);
        pendingTranscriptMirrors.push(pending);
        return pending;
      });
    restoreTranscriptMirror = () => observer.mockRestore();
    lifetime = new AbortController();
    stopped = createDeferred<never>();
    void stopped.promise.catch(() => undefined);
    resetTelegramAccountThrottlersForTest();
    bot = new Bot(BOT_TOKEN, { client: { apiRoot } });
    const requestLifetime = lifetime.signal;
    bot.api.config.use(async (previous, method, payload, signal) => {
      requestLifetime.throwIfAborted();
      const controller = new TelegramAbortController();
      const abort = () => controller.abort();
      requestLifetime.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        controller.abort();
      }
      const request = previous(method, payload, controller.signal);
      pendingRequests.add(request);
      if (method === "deleteMessage") {
        pendingDeletes.push(request);
      }
      return request.finally(() => {
        pendingRequests.delete(request);
        requestLifetime.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
      });
    });
    holdNextCall = undefined;
    // SQLite workers share native hrtime deadlines with the dispatching thread.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    calls.length = 0;
    endpoints.length = 0;
    acceptedCalls.length = 0;
    visibleMessages.clear();
    visibleMarkup.clear();
    respondToCall = undefined;
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    rejectNextQuote = false;
    nextMessageId = 0;
    resetPluginStateStoreForTests({ closeDatabase: false });
    setTelegramPluginStateRuntimeForTests();
  });

  async function settleDetachedDeletes() {
    // Preview retirement is detached; finish it before reusing the fixture's message IDs.
    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.allSettled(pendingDeletes.splice(0));
    await vi.advanceTimersByTimeAsync(0);
  }

  afterEach(async () => {
    const ended = new Error("Telegram HTTP fixture ended");
    lifetime.abort(ended);
    stopped.reject(ended);
    await Promise.allSettled(pendingDispatches);
    await Promise.allSettled([...pendingRequests, typingSend]);
    await settleDetachedDeletes();
    // Preview mirrors start before entering the writer queue; join their full
    // lifetime so cleanup cannot delete a store that a late mirror recreates.
    await Promise.allSettled(pendingTranscriptMirrors.splice(0));
    restoreTranscriptMirror();
    for (const adapter of bindingAdapters.values()) {
      unregisterSessionBindingAdapter({ ...adapter, adapter });
    }
    bindingAdapters.clear();
    resetTelegramAccountThrottlersForTest();
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    resetGlobalHookRunner();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  async function waitForBotApiCall(predicate: (call: RecordedBotApiCall) => boolean) {
    lifetime.signal.throwIfAborted();
    if (calls.some(predicate)) {
      return;
    }
    // A wakeup may race another recorded request whose response is still held.
    while (!calls.some((call) => completedCalls.has(call) && predicate(call))) {
      await once(botApiCalls, "call", { signal: lifetime.signal });
    }
  }

  afterAll(async () => {
    server.closeAllConnections();
    await once(server.close(), "close");
  });

  function createContext(): TelegramMessageContext {
    const text = "Run the failing command.";
    // Each turn is a new inbound message; a repeated id is dropped as a duplicate.
    const inboundMessageId = 456 + inboundSequence++;
    return {
      ctxPayload: {
        Body: text,
        BodyForAgent: text,
        RawBody: text,
        CommandBody: text,
        ChatType: "direct",
        From: String(CHAT_ID),
        To: String(CHAT_ID),
        MessageSid: String(inboundMessageId),
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: `agent:default:telegram:direct:${CHAT_ID}`,
        Timestamp: 1_700_000_000_000,
      },
      primaryCtx: { message: { chat: { id: CHAT_ID, type: "private" } } },
      msg: { chat: { id: CHAT_ID, type: "private" }, message_id: inboundMessageId, text },
      chatId: CHAT_ID,
      isGroup: false,
      isForum: false,
      threadSpec: { id: undefined, scope: "none" },
      historyLimit: 0,
      route: {
        agentId: "default",
        accountId: "default",
        sessionKey: `agent:default:telegram:direct:${CHAT_ID}`,
      },
      sendTyping: async () => undefined,
      sendRecordVoice: async () => undefined,
      sendChatActionHandler: { sendChatAction: async () => undefined },
      ackReactionPromise: null,
      statusReactionController: null,
      accountId: "default",
      turn: {
        storePath: state.path("sessions.json"),
        recordInboundSession: async () => undefined,
        record: { onRecordError: () => undefined },
      },
    } as unknown as TelegramMessageContext;
  }

  async function emitToolStart(
    options: ReplyResolverOptions,
    payload: {
      toolCallId: string;
      name: string;
      phase: "start" | "update";
      args?: Record<string, unknown>;
    },
  ) {
    await options?.onItemEvent?.(projectAgentToolActivity(payload));
    await options?.onToolStart?.(payload);
  }

  async function dispatchProgressTurn(
    emitEvents: (
      options: ReplyResolverOptions,
      channelOptions: ReplyResolverOptions,
    ) => Promise<void>,
    scenario?: DispatchScenario,
  ) {
    const caseSignal = lifetime.signal;
    const work = (async () => {
      let channelOptions: ReplyResolverOptions;
      const replyResolver: ReplyResolver = async (_ctx, options) => {
        if (!options?.suppressTyping) {
          await options?.onReplyStart?.();
        }
        await options?.onAssistantMessageStart?.();
        await emitEvents(options, channelOptions);
        // The final answer follows the finished progress edit, as a model that
        // answers after reading the command output does. Earlier edits may flush
        // first (attention statuses bypass the edit throttle).
        if (!scenario) {
          await waitForBotApiCall(
            (call) =>
              call.method === "editMessageText" && String(call.fields.text).includes("failed"),
          );
        }
        return scenario?.finalReply ?? { text: "The command failed." };
      };
      const replyToMode = scenario?.replyToMode ?? "off";
      const telegramCfg: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"] = {
        botToken: BOT_TOKEN,
        apiRoot,
        streaming: {
          mode: scenario?.mode ?? "progress",
          preview: { toolProgress: scenario?.toolProgress ?? true, commandText: "raw" },
          progress: { toolProgress: scenario?.toolProgress ?? true, commandText: "raw" },
        },
        ...scenario?.telegramCfg,
        replyToMode,
      };
      const cfg: OpenClawConfig = {
        ...scenario?.cfg,
        session: { store: state.path("sessions.json"), ...scenario?.cfg?.session },
        channels: {
          telegram: scenario?.accountId
            ? {
                enabled: true,
                defaultAccount: scenario.accountId,
                accounts: {
                  [scenario.accountId]: {
                    richMessages: false,
                    ...telegramCfg,
                    streaming: { ...telegramCfg.streaming, block: { enabled: false } },
                  },
                },
              }
            : telegramCfg,
        },
      };
      scenario?.onDispatch?.(cfg);
      const errors: string[] = [];
      const context = scenario?.context ?? createContext();
      context.sendTyping = () => {
        typingSend = bot.api.sendChatAction(context.chatId, "typing").then(() => undefined);
        return typingSend;
      };
      if (scenario?.accountId) {
        context.accountId = scenario.accountId;
        context.route.accountId = scenario.accountId;
        context.ctxPayload.AccountId = scenario.accountId;
      }

      // This delivery fixture starts below createTelegramBot, which normally owns
      // the account adapter even when thread bindings are disabled.
      if (!bindingAdapters.has(context.accountId)) {
        const adapter: SessionBindingAdapter = {
          channel: "telegram",
          accountId: context.accountId,
          capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
          listBySession: () => [],
          resolveByConversation: () => null,
        };
        registerSessionBindingAdapter(adapter);
        bindingAdapters.set(context.accountId, adapter);
      }

      const result = await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime: {
          log: () => undefined,
          error: (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
          },
          exit: () => {
            throw new Error("exit");
          },
        },
        replyToMode,
        streamMode: scenario?.mode ?? "progress",
        textLimit: scenario?.textLimit ?? 4096,
        telegramCfg,
        retryDispatchErrors: true,
        turnAdoptionLifecycle: scenario?.turnAdoptionLifecycle,
        suppressFailureFallback: scenario?.suppressFailureFallback,
        opts: {
          token: BOT_TOKEN,
          dispatchReplyFromConfig: async (params) => {
            channelOptions = params.replyOptions;
            return await dispatchInboundMessage({
              ctx: params.ctx,
              cfg: params.cfg,
              dispatcher: params.dispatcher,
              replyOptions: {
                ...params.replyOptions,
                abortSignal: params.replyOptions?.abortSignal
                  ? AbortSignal.any([caseSignal, params.replyOptions.abortSignal])
                  : caseSignal,
              },
              onSessionMetadataChanges: params.onSessionMetadataChanges,
              replyResolver,
              dispatchReplyFromConfig: scenario?.producer,
            });
          },
        },
      });
      await settleDetachedDeletes();

      if (!scenario?.allowErrors) {
        expect(errors).toEqual([]);
      }
      expect(result.kind).toBe(scenario?.outcome ?? "completed");
      return calls
        .filter((call) => call.method === "sendMessage" || call.method === "editMessageText")
        .map((call) => [call.method, call.fields.message_id ?? null, call.fields.text] as const);
    })();
    pendingDispatches.add(work);
    return work.finally(() => pendingDispatches.delete(work));
  }

  const callsFor = (method: string) => calls.filter((call) => call.method === method);
  const acceptedFor = (method: string) => acceptedCalls.filter((call) => call.method === method);
  const waitForMethod = (method: string) => waitForBotApiCall((call) => call.method === method);
  const waitForText = (text: string, method?: string) =>
    waitForBotApiCall((call) => (!method || call.method === method) && call.fields.text === text);
  const waitForContaining = (text: string, method?: string) =>
    waitForBotApiCall(
      (call) => (!method || call.method === method) && String(call.fields.text).includes(text),
    );

  return {
    callsFor,
    acceptedFor,
    waitForMethod,
    waitForText,
    waitForContaining,
    texts: () => [...visibleMessages.values()],
    token: BOT_TOKEN,
    get apiRoot() {
      return apiRoot;
    },
    get state() {
      return state;
    },
    get bot() {
      return bot;
    },
    set holdNextCall(value: typeof holdNextCall) {
      holdNextCall = value;
    },
    calls,
    endpoints,
    visibleMessages,
    visibleMarkup,
    acceptedCalls,
    createContext,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall,
    waitForTypingSend: () => typingSend,
    set respondToCall(value: typeof respondToCall) {
      respondToCall = value;
    },
    set rejectNextQuote(value: boolean) {
      rejectNextQuote = value;
    },
  };
}
