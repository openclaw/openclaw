import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Api } from "grammy";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { DEFAULT_INGRESS_ADOPTION_STALL_MS } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  onDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "openclaw/plugin-sdk/logging-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "openclaw/plugin-sdk/webhook-ingress";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayLifecycle,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { monitorTelegramProvider } from "./monitor.js";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";
import {
  createHeldTelegramReplay,
  writeTelegramSpooledUpdate,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
} from "./telegram-ingress-spool.test-support.js";
import { createTelegramWebhookIdleAdmissionFixture } from "./test-support/webhook-admission.js";
import {
  createNearLimitTelegramPayload,
  createTelegramPrivateTopicCallback,
  expectMockMessageContains,
  expectSingleNearLimitUpdate,
  expectStatusCall,
  expectWebhookBotScopesAborted,
  requireMockCall,
  requireRecord,
  telegramMessageUpdate,
  telegramWebhookListenerCases,
  waitForWebhookState,
  type TestTelegramMessageUpdate,
} from "./test-support/webhook-fixtures.js";
import {
  createTelegramWebhookTestGateway,
  getServerPort,
  webhookUrl,
} from "./test-support/webhook-gateway.js";
import {
  postWebhookHeadersOnly,
  postWebhookJson,
  postWebhookPayloadWithChunkPlan,
  postWebhookWithDeclaredLength,
  yieldWebhookTask,
} from "./test-support/webhook-http.js";
import { registerTelegramWebhookRegistrationTests } from "./test-support/webhook-registration.js";

const legacyListenerForRequest = vi.hoisted(() =>
  vi.fn((): { port: number; host?: string } | undefined => undefined),
);
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: legacyListenerForRequest,
}));

const handleUpdateSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const answerCallbackQuerySpy = vi.hoisted(() => vi.fn(async () => true));
const setWebhookSpy = vi.hoisted(() => vi.fn<Api["setWebhook"]>());
const deleteWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
const initSpy = vi.hoisted(() => vi.fn(async () => undefined));
const stopSpy = vi.hoisted(() => vi.fn());
const webhookBotInfo = vi.hoisted(() => ({
  id: 123,
  is_bot: true as const,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  has_topics_enabled: false,
}));
const createWebhookBot = vi.hoisted(() => () => ({
  init: initSpy,
  botInfo: webhookBotInfo,
  handleUpdate: handleUpdateSpy,
  api: {
    setWebhook: setWebhookSpy,
    deleteWebhook: deleteWebhookSpy,
    answerCallbackQuery: answerCallbackQuerySpy,
  },
  stop: stopSpy,
}));
const createTelegramBotSpy = vi.hoisted(() => vi.fn(createWebhookBot));
const transportCloseSpies = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
const resolveTelegramTransportSpy = vi.hoisted(() =>
  vi.fn(() => {
    const close = vi.fn(async () => undefined);
    transportCloseSpies.push(close);
    return {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close,
    };
  }),
);

const WEBHOOK_POST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 8_000;
const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const webhookOptions = { secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH };
const TELEGRAM_WEBHOOK_RATE_LIMIT_BURST = WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests + 10;

vi.mock("grammy", async () => {
  const actual = await vi.importActual<typeof import("grammy")>("grammy");
  return {
    ...actual,
    API_CONSTANTS: actual.API_CONSTANTS ?? {
      DEFAULT_UPDATE_TYPES: ["message"],
      ALL_UPDATE_TYPES: ["message"],
    },
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: resolveTelegramTransportSpy,
}));

const gateway = createTelegramWebhookTestGateway({
  token: TELEGRAM_TOKEN,
  queueScope: requireWebhookQueueScope,
});
const {
  startWebhook: startTelegramWebhook,
  server: gatewayServer,
  pendingRequests: pendingRouteRequests,
} = gateway;
let webhookStateDir: string | undefined;

function requireWebhookQueueScope() {
  if (!webhookStateDir) {
    throw new Error("webhook state dir not initialized");
  }
  return { stateDir: webhookStateDir, accountId: "test" };
}

function testRuntime(log = vi.fn(), error = vi.fn()) {
  return { log, error, exit: vi.fn() };
}
function startWebhookProvider(options: Parameters<typeof monitorTelegramProvider>[0]) {
  return monitorTelegramProvider({
    token: TELEGRAM_TOKEN,
    accountId: "test",
    config: {},
    useWebhook: true,
    webhookUrl: webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH),
    webhookPath: TELEGRAM_WEBHOOK_PATH,
    webhookSecret: TELEGRAM_SECRET,
    runtime: testRuntime(),
    ...options,
  });
}

function privateMessage(
  update_id: number,
  text: string,
  message_id = 1,
  message_thread_id?: number,
) {
  return {
    update_id,
    message: {
      chat: { id: 1234, type: "private" },
      message_id,
      text,
      ...(message_thread_id === undefined ? {} : { message_thread_id }),
    },
  };
}
async function expectAccepted(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
  expect(await response.text()).toBe("");
}
function expectStopped() {
  expect(stopSpy).toHaveBeenCalledOnce();
  expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
}
async function expectInvalidLane(laneKey: string) {
  await withWebhook(async ({ ingress }) => {
    await ingress.waitForIdle();
    expect(await webhookQueue().listFailed?.({ limit: "all" })).toMatchObject([
      { reason: "invalid-event", laneKey },
    ]);
    expect(handleUpdateSpy).not.toHaveBeenCalled();
  });
}

async function expectReplayed(update: unknown) {
  await withWebhook(async ({ ingress }) => {
    await ingress.waitForIdle();
    expect(handleUpdateSpy).toHaveBeenCalledOnce();
    expect(handleUpdateSpy).toHaveBeenCalledWith(update);
    expect(await webhookQueue().listFailed?.()).toEqual([]);
  });
}

function withWebhook<T>(
  run: (ctx: Parameters<Parameters<typeof gateway.withWebhook>[1]>[0]) => Promise<T>,
  options: Parameters<typeof gateway.withWebhook>[0] = {},
) {
  return gateway.withWebhook({ ...webhookOptions, ...options }, run);
}

function webhookQueue() {
  return openTelegramIngressQueue(requireWebhookQueueScope());
}
function pendingUpdates() {
  return listTelegramSpooledUpdates(requireWebhookQueueScope());
}
function spoolUpdate(update: unknown, laneKey?: string) {
  return writeTelegramSpooledUpdate({ ...requireWebhookQueueScope(), update, laneKey });
}
async function closeStateDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
function postUpdate(endpoint: number | string, update: unknown, secret = TELEGRAM_SECRET) {
  return postWebhookJson({
    url: typeof endpoint === "number" ? webhookUrl(endpoint, TELEGRAM_WEBHOOK_PATH) : endpoint,
    payload: JSON.stringify(update),
    secret,
  });
}
function approvalData(
  approvalKind: Parameters<typeof buildTelegramApprovalCallbackData>[0]["approvalKind"],
  decision: Parameters<typeof buildTelegramApprovalCallbackData>[0]["decision"],
) {
  return buildTelegramApprovalCallbackData({
    type: "approval",
    approvalKind,
    approvalId: "signed-approval",
    decision,
  });
}

type Callback = ReturnType<typeof createTelegramPrivateTopicCallback>;
type CallbackPatch = Partial<Omit<Callback, "from" | "message">> & {
  from?: Omit<Partial<Callback["from"]>, "is_bot"> & { is_bot?: boolean };
  inline_message_id?: string;
  inlineOnly?: boolean;
  message?: Partial<Omit<Callback["message"], "from" | "chat">> & {
    from?: Partial<Callback["message"]["from"]>;
    chat?: Partial<Callback["message"]["chat"]>;
    business_connection_id?: string;
    guest_query_id?: string;
    sender_chat?: { id: number; type: "channel" };
    direct_messages_topic?: { topic_id: number };
  };
};
function patchedCallback({ from, message, inlineOnly, ...patch }: CallbackPatch) {
  const callback = createTelegramPrivateTopicCallback(141, webhookBotInfo.id);
  const { message: originalMessage, ...envelope } = callback;
  return {
    ...envelope,
    ...patch,
    from: { ...callback.from, ...from },
    ...(!inlineOnly
      ? {
          message: {
            ...originalMessage,
            ...message,
            from: { ...originalMessage.from, ...message?.from },
            chat: { ...originalMessage.chat, ...message?.chat },
          },
        }
      : {}),
  };
}

function holdWebhookUpdate(heldId: number) {
  const seenUpdateIds: number[] = [];
  const firstUpdateStarted = createDeferred<void>();
  const firstUpdateCompleted = createDeferred<void>();
  handleUpdateSpy.mockImplementation(async (update: unknown) => {
    const updateId = (update as { update_id: number }).update_id;
    seenUpdateIds.push(updateId);
    if (updateId === heldId) {
      firstUpdateStarted.resolve();
      await firstUpdateCompleted.promise;
    }
  });
  return { seenUpdateIds, firstUpdateStarted, firstUpdateCompleted };
}

function resetTelegramWebhookMocks(): void {
  legacyListenerForRequest.mockReset().mockReturnValue(undefined);
  handleUpdateSpy.mockReset().mockImplementation((..._args: unknown[]): unknown => undefined);
  answerCallbackQuerySpy.mockReset().mockImplementation(async () => true);

  setWebhookSpy.mockReset();
  deleteWebhookSpy.mockReset().mockImplementation(async () => true);
  initSpy.mockReset().mockImplementation(async () => undefined);
  stopSpy.mockReset();
  resolveTelegramTransportSpy.mockClear();
  transportCloseSpies.length = 0;
  webhookBotInfo.has_topics_enabled = false;
  createTelegramBotSpy.mockReset().mockImplementation(createWebhookBot);
}

beforeAll(() => gateway.listen());
afterAll(() => gateway.close());

beforeEach(async () => {
  gateway.resetRegistry();
  resetTelegramWebhookMocks();
  webhookStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-telegram-webhook-"));
  installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir());
  // The production monitor prepares shared state before starting the webhook.
  await webhookQueue().listPending();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearTelegramRuntime();
  await closeStateDatabase();
  const stateDir = webhookStateDir;
  webhookStateDir = undefined;
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

type WebhookOptions = Parameters<typeof startTelegramWebhook>[0];
function startScopedWebhook(options: Partial<WebhookOptions> = {}) {
  return startWebhookStartupFixture({
    ...webhookOptions,
    ...requireWebhookQueueScope(),
    ...options,
  });
}

function startWebhookStartupFixture(options: Partial<WebhookOptions> = {}) {
  return startTelegramWebhook({
    token: TELEGRAM_TOKEN,
    secret: TELEGRAM_SECRET,
    runtime: testRuntime(),
    ...options,
  });
}

describe("startTelegramWebhook", () => {
  it.each([
    { binding: "standalone", enabled: true },
    { binding: "runtime", enabled: false },
  ] as const)(
    "respects $binding diagnostics (enabled=$enabled) and preserves the host heartbeat",
    async ({ binding, enabled }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const events: string[] = [];
      const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
      startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
      const config = { diagnostics: { enabled } };
      const followsRuntime = binding === "runtime";
      if (followsRuntime) {
        setRuntimeConfigSnapshot(config, config);
      }
      try {
        await withWebhook(
          async ({ port, server }) => {
            let expectedEvents = 0;
            for (const currentEnabled of followsRuntime ? [false, true, false] : [enabled]) {
              if (followsRuntime) {
                setRuntimeConfigSnapshot({ diagnostics: { enabled: currentEnabled } });
              }
              const response = await postWebhookJson({
                url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
                payload: "{}",
              });
              expect(response.status).toBe(401);
              await waitForDiagnosticEventsDrained();
              expectedEvents += currentEnabled ? 1 : 0;
              expect(events.filter((event) => event === "webhook.received")).toHaveLength(
                expectedEvents,
              );
            }
            expect(server.listening).toBe(true);
            expect(initSpy).toHaveBeenCalledOnce();
          },
          { config },
        );
        logWebhookReceived({ channel: "host" });
        await vi.advanceTimersByTimeAsync(30_000);
        await waitForDiagnosticEventsDrained();
        expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(1);
      } finally {
        clearRuntimeConfigSnapshot();
        stopDiagnosticHeartbeat();
        unsubscribe();
      }
    },
  );

  it("prepares a wildcard legacy listener and accepts its signed callback", async () => {
    const endpoint = { port: 8787, host: "0.0.0.0" };
    await withWebhook(
      async ({ port }) => {
        expect(gateway.registry.httpRoutes[0]?.legacyListeners).toEqual([
          { ...endpoint, health: { path: "/healthz" } },
        ]);
        legacyListenerForRequest.mockReturnValue(endpoint);
        expect(
          (await postUpdate(port, telegramMessageUpdate(809, "legacy bind address"))).status,
        ).toBe(200);
      },
      { legacyWebhook: endpoint },
    );
  });

  it("routes duplicate module copies by secret and rejects ambiguous accounts", async () => {
    const [firstModule, secondModule] = await Promise.all([
      importFreshModule<typeof import("./webhook.js")>(
        import.meta.url,
        "./webhook.js?scope=telegram-webhook-first",
      ),
      importFreshModule<typeof import("./webhook.js")>(
        import.meta.url,
        "./webhook.js?scope=telegram-webhook-second",
      ),
    ]);
    expect(firstModule.startTelegramWebhook).not.toBe(secondModule.startTelegramWebhook);
    const statusA = vi.fn();
    const statusB = vi.fn();
    const base = {
      token: TELEGRAM_TOKEN,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      publicUrl: webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH),
    };
    const first = await firstModule.startTelegramWebhook({
      ...base,
      accountId: "first",
      secret: "first-secret",
      setStatus: statusA,
    });
    const second = await secondModule.startTelegramWebhook({
      ...base,
      accountId: "second",
      secret: "second-secret",
      legacyWebhook: { port: 8787, host: "127.0.0.1" },
      setStatus: statusB,
    });
    try {
      statusA.mockClear();
      statusB.mockClear();
      const send = (id: number, text: string) =>
        postUpdate(getServerPort(gatewayServer), telegramMessageUpdate(id, text), "second-secret");
      const accepted = await send(801, "second account");
      expect(accepted.status).toBe(200);
      expect(statusA).not.toHaveBeenCalled();
      expect(statusB).toHaveBeenCalled();
      const ambiguous = await secondModule.startTelegramWebhook({
        ...base,
        accountId: "ambiguous",
        secret: "second-secret",
        legacyWebhook: { port: 8788, host: "127.0.0.1" },
      });
      try {
        const rejected = await send(802, "ambiguous account");
        expect(rejected.status).toBe(401);
        legacyListenerForRequest.mockReturnValue({ port: 8787, host: "127.0.0.1" });
        statusB.mockClear();
        const legacyAccepted = await send(804, "legacy account");
        expect(legacyAccepted.status).toBe(200);
        expect(statusB).toHaveBeenCalled();
        legacyListenerForRequest.mockReturnValue({ port: 8789, host: "127.0.0.1" });
        const wrongEndpoint = await send(805, "wrong legacy endpoint");
        expect(wrongEndpoint.status).toBe(404);
      } finally {
        legacyListenerForRequest.mockReturnValue(undefined);
        await ambiguous.stop();
      }
      await first.stop();
      expect(gateway.registry.httpRoutes).toHaveLength(1);
      const remaining = await send(803, "remaining account");
      expect(remaining.status).toBe(200);
    } finally {
      await first.stop();
      await second.stop();
    }
    expect(gateway.registry.httpRoutes).toHaveLength(0);
  });

  it("aborts bot fetches and account-owned work when the webhook stops", async () => {
    const callerAbort = new AbortController();
    const started = await startScopedWebhook({ abortSignal: callerAbort.signal });

    try {
      const botParams = requireRecord(
        requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
        "createTelegramBot params",
      );
      const aborted = ["fetchAbortSignal", "accountAbortSignal"].map((key) => {
        const signal = botParams[key];
        expect(signal).toBeInstanceOf(AbortSignal);
        if (!(signal instanceof AbortSignal)) {
          throw new Error("expected bot fetch and account abort signals");
        }
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      await started.stop();
      await expect(Promise.all(aborted)).resolves.toEqual([undefined, undefined]);
      expect(callerAbort.signal.aborted).toBe(false);
    } finally {
      await started.stop();
      callerAbort.abort();
    }
  });

  registerTelegramWebhookRegistrationTests({
    gateway,
    setWebhookSpy,
    stopSpy,
    transportCloseSpies,
    startWebhookStartupFixture,
    requireWebhookQueueScope,
    token: TELEGRAM_TOKEN,
    secret: TELEGRAM_SECRET,
    path: TELEGRAM_WEBHOOK_PATH,
  });

  it("retries transient getMe startup init failures before starting the account", async () => {
    const runtimeLog = vi.fn();
    const setStatus = vi.fn();
    initSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(undefined);

    await withWebhook(
      async ({ port }) => {
        await expectAccepted(await postUpdate(port, telegramMessageUpdate(806, "startup webhook")));
      },
      {
        runtime: testRuntime(runtimeLog),
        setStatus,
        webhookRegistrationRetryPolicy: {
          initialMs: 0,
          maxMs: 0,
          factor: 1,
          jitter: 0,
        },
      },
    );

    expect(initSpy).toHaveBeenCalledTimes(2);
    expect(runtimeLog).toHaveBeenCalledWith("telegram getMe retry 1 scheduled in 0ms");
    expectStatusCall(setStatus, { lifecycle: "recovering" });
    expect(setWebhookSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["creation", "initialization", "route registration", "ingress queue"] as const)(
    "releases startup resources after failed %s",
    async (phase) => {
      const abort = new AbortController();
      const runtimeError = vi.fn();
      const setStatus = vi.fn();
      const failure =
        phase === "initialization"
          ? Object.assign(new Error("unauthorized"), { error_code: 401 })
          : new Error(phase === "creation" ? "bot setup failed" : "state database unavailable");
      if (phase === "creation") {
        createTelegramBotSpy.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (phase === "initialization") {
        initSpy.mockRejectedValueOnce(failure);
        stopSpy.mockRejectedValueOnce(new Error("bot stop failed"));
      } else if (phase === "route registration") {
        gateway.registry.httpRoutes.push({
          path: TELEGRAM_WEBHOOK_PATH,
          pluginId: "other",
          auth: "plugin",
          match: "exact",
          handler: () => true,
        });
      } else {
        installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir(), failure);
      }
      try {
        const startup = startWebhookStartupFixture({
          ...(phase === "creation" ? {} : { path: TELEGRAM_WEBHOOK_PATH }),
          ...requireWebhookQueueScope(),
          ...(phase === "ingress queue" ? { abortSignal: abort.signal } : {}),
          runtime: testRuntime(undefined, runtimeError),
          setStatus,
        });
        if (phase === "route registration") {
          await expect(startup).rejects.toThrow(/route reuse denied/);
        } else {
          await expect(startup).rejects.toBe(failure);
        }
        expect(setWebhookSpy).toHaveBeenCalledTimes(phase === "ingress queue" ? 1 : 0);
        expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
        expectWebhookBotScopesAborted(createTelegramBotSpy);
        if (phase === "creation") {
          expect(initSpy).not.toHaveBeenCalled();
        } else {
          expect(stopSpy).toHaveBeenCalledOnce();
        }
        if (phase === "initialization" || phase === "ingress queue") {
          expect(deleteWebhookSpy).not.toHaveBeenCalled();
          expectStatusCall(
            setStatus,
            phase === "initialization"
              ? { lifecycle: "blocked", lastError: "unauthorized" }
              : { lastError: "state database unavailable" },
          );
        }
        if (phase === "initialization") {
          expectMockMessageContains(
            runtimeError,
            "telegram webhook bot stop failed: bot stop failed",
          );
        }
        if (phase === "ingress queue") {
          expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
          expect(gateway.registry.httpRoutes).toHaveLength(0);
        }
      } finally {
        if (phase === "ingress queue") {
          abort.abort();
          expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("registers webhook with certificate when webhookCertPath is provided", async () => {
    await withWebhook(
      async () => {
        const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
        expect(typeof setWebhookCall[0]).toBe("string");
        const options = requireRecord(setWebhookCall[1], "setWebhook options");
        expect(options.certificate).toMatchObject({
          fileData: "/path/to/cert.pem",
          filename: "cert.pem",
        });
      },
      { webhookCertPath: "/path/to/cert.pem" },
    );
  });

  it("acks before webhook update processing finishes", async () => {
    const slowUpdate = telegramMessageUpdate(2, "slow");
    const setStatus = vi.fn();
    const finishWork = createDeferred<void>();
    let workStarted = false;
    let workFinished = false;
    handleUpdateSpy.mockImplementationOnce(async (update: unknown) => {
      expect(update).toEqual(telegramMessageUpdate(2, "slow"));
      workStarted = true;
      await finishWork.promise;
      workFinished = true;
    });

    await withWebhook(
      async ({ port }) => {
        setStatus.mockClear();
        const receivedAfter = Date.now();
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(slowUpdate),
          secret: TELEGRAM_SECRET,
          timeoutMs: 1_000,
        });

        await expectAccepted(response);
        await waitForWebhookState(() => expect(workStarted).toBe(true));
        expect(workFinished).toBe(false);
        const receivedStatus = requireRecord(
          requireMockCall(setStatus, 0, "setStatus")[0],
          "webhook activity status",
        );
        expect(receivedStatus).toEqual({ lastEventAt: expect.any(Number) });
        expect(receivedStatus.lastEventAt).toBeGreaterThanOrEqual(receivedAfter);

        finishWork.resolve();
        await waitForWebhookState(() => expect(workFinished).toBe(true));
      },
      { setStatus },
    );
  });

  it("answers a durably admitted callback before its same-chat lane drains", async () => {
    const blockingUpdate = telegramMessageUpdate(5, "slow");
    blockingUpdate.message.chat.id = 1234;
    const callbackUpdate = {
      update_id: 6,
      callback_query: createTelegramPrivateTopicCallback(6, webhookBotInfo.id),
    };
    const { seenUpdateIds, firstUpdateCompleted: blockingUpdateCompleted } = holdWebhookUpdate(
      blockingUpdate.update_id,
    );

    await withWebhook(async ({ port }) => {
      const url = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
      try {
        expect((await postUpdate(url, blockingUpdate)).status).toBe(200);
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([5]));

        const callbackResponse = await postUpdate(url, callbackUpdate);
        expect(callbackResponse.status).toBe(200);
        expect(callbackResponse.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(answerCallbackQuerySpy).toHaveBeenCalledWith("callback-6");
        expect(seenUpdateIds).toEqual([5]);
      } finally {
        blockingUpdateCompleted.resolve();
      }

      await waitForWebhookState(() => expect(seenUpdateIds).toEqual([5, 6]));
    });
  });

  it("bounds shutdown when a webhook handler ignores abort", async () => {
    const releaseWork = createDeferred<void>();
    handleUpdateSpy.mockImplementationOnce(() => releaseWork.promise);
    const started = await startScopedWebhook();

    try {
      const response = await postUpdate(
        getServerPort(started.server),
        telegramMessageUpdate(3, "stuck"),
      );
      expect(response.status).toBe(200);
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledOnce());

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopTask = started.stop();
      await vi.advanceTimersByTimeAsync(15_000);
      await stopTask;

      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expectStopped();
    } finally {
      releaseWork.resolve();
      vi.useRealTimers();
      await started.stop();
    }
  });

  it("joins concurrent stops with abort-driven webhook cleanup", async () => {
    const stopEntered = createDeferred<void>();
    const finishStop = createDeferred<void>();
    stopSpy.mockImplementationOnce(() => {
      stopEntered.resolve();
      return finishStop.promise;
    });
    const abort = new AbortController();
    const started = await startScopedWebhook({ abortSignal: abort.signal });
    abort.abort();
    let stopped = false;
    const stopping = Promise.all([started.stop(), started.stop()]).then(() => {
      stopped = true;
    });
    try {
      await stopEntered.promise;
      expect(stopSpy).toHaveBeenCalledOnce();
      await yieldWebhookTask();
      expect(stopped).toBe(false);
      expect(transportCloseSpies[0]).not.toHaveBeenCalled();
    } finally {
      finishStop.resolve();
      await stopping;
      expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    }
  });

  it("does not dispatch queued work when the webhook provider starts aborted", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", webhookStateDir);
    await spoolUpdate(telegramMessageUpdate(62, "not accepted"));
    await startWebhookProvider({
      abortSignal: AbortSignal.abort(new Error("account stopped")),
    });

    expect(handleUpdateSpy).not.toHaveBeenCalled();
    expect(setWebhookSpy).not.toHaveBeenCalled();
    expectStopped();
    expect((await pendingUpdates()).map((entry) => entry.updateId)).toEqual([62]);
  });

  it.each(["commit", "rollback", "introduction"] as const)(
    "joins accepted %s beyond webhook provider shutdown grace",
    async (operation) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", webhookStateDir);
      const abort = new AbortController();
      const registered = createDeferred<void>();
      setWebhookSpy.mockImplementationOnce(async () => {
        registered.resolve();
        return true;
      });
      const replay = createHeldTelegramReplay(operation);
      const { operationStarted, releaseOperation, recorded } = replay;
      const setStatus = vi.fn();
      let settlement: Promise<void> | undefined;
      handleUpdateSpy.mockImplementationOnce(async () => {
        const participant = createTelegramSpooledReplayDeferredParticipant("held-webhook-work");
        if (!participant) {
          throw new Error("Expected accepted webhook settlement ownership");
        }
        settlement = replay.settle(participant);
        await settlement;
      });
      let stopped = false;
      const provider = startWebhookProvider({
        abortSignal: abort.signal,
        setStatus,
      }).then(() => {
        stopped = true;
      });
      try {
        await Promise.race([
          registered.promise,
          provider.then(() => {
            throw new Error("Telegram provider stopped before webhook registration");
          }),
        ]);
        expect(setWebhookSpy).toHaveBeenCalledOnce();
        const url = requireMockCall(setWebhookSpy, 0, "setWebhook")[0];
        if (typeof url !== "string") {
          throw new Error("Expected the isolated Gateway webhook URL");
        }
        const response = await postUpdate(url, telegramMessageUpdate(61, "held webhook work"));
        expect(response.status).toBe(200);
        await operationStarted.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abort.abort();
        await vi.advanceTimersByTimeAsync(16_000);
        expect(stopped).toBe(false);
        expectStopped();
      } finally {
        releaseOperation.resolve();
        await settlement;
        abort.abort();
        await provider;
        vi.useRealTimers();
        await waitForWebhookState(async () =>
          expect(await listTelegramSpooledUpdateClaims(requireWebhookQueueScope())).toEqual([]),
        );
      }
      expect([...recorded]).toEqual(
        operation === "rollback"
          ? []
          : operation === "introduction"
            ? ["introduction"]
            : ["first", "second"],
      );
      expect((await pendingUpdates()).map((entry) => entry.updateId)).toEqual(
        operation === "rollback" ? [61] : [],
      );
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
    },
  );

  it("retains the registered HTTP invocation until durable admission and acknowledgment", async () => {
    const { runtime, enqueueGate, enqueueStarted } = createTelegramWebhookIdleAdmissionFixture(
      () => webhookStateDir ?? os.tmpdir(),
    );
    setTelegramRuntime(runtime);

    await withWebhook(async ({ port, ingress }) => {
      // The idle singleton path must hit the real atomic enqueue-and-claim operation.
      await ingress.waitForIdle();
      let responseSettled = false;
      const responseTask = postUpdate(port, telegramMessageUpdate(4, "commit gate")).then(
        (response) => {
          responseSettled = true;
          return response;
        },
      );

      try {
        await Promise.race([
          enqueueStarted.promise,
          responseTask.then(() => {
            throw new Error("Webhook responded before reaching the held durable admission");
          }),
        ]);
        await yieldWebhookTask();
        expect(responseSettled).toBe(false);
        expect(pendingRouteRequests.size).toBe(1);

        enqueueGate.resolve();
        const response = await responseTask;
        await expectAccepted(response);
        expect(pendingRouteRequests.size).toBe(0);
      } finally {
        enqueueGate.resolve();
      }
    });
  });

  it("durably retries a webhook update after acknowledging Telegram", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const runtimeLog = vi.fn();
    const seenUpdates: unknown[] = [];
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      seenUpdates.push(update);
      if (seenUpdates.length === 1) {
        recordTelegramMessageProcessingResult({
          kind: "failed-retryable",
          error: new Error("agent turn failed"),
        });
      }
    });
    const update = telegramMessageUpdate(3, "boom");

    await withWebhook(
      async ({ port }) => {
        const response = await postUpdate(port, update);

        await expectAccepted(response);
        await waitForWebhookState(() => expect(seenUpdates).toEqual([update]));
        await waitForWebhookState(async () =>
          expect(await pendingUpdates()).toMatchObject([
            { updateId: 3, attempts: 1, lastError: "agent turn failed" },
          ]),
        );
        expectMockMessageContains(runtimeLog, "webhook spooled update 3 failed; keeping for retry");
        vi.setSystemTime(Date.now() + 1_100);
        await vi.advanceTimersByTimeAsync(500);
        await waitForWebhookState(() => expect(seenUpdates).toEqual([update, update]));
        await waitForWebhookState(async () => expect(await pendingUpdates()).toEqual([]));
      },
      { runtime: testRuntime(runtimeLog) },
    );
  });

  it.each([
    ["environment override", "50", 50],
    ["canonical default", undefined, DEFAULT_INGRESS_ADOPTION_STALL_MS],
  ] as const)("uses the %s for webhook adoption stalls", async (_label, envValue, timeoutMs) => {
    vi.stubEnv("OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS", envValue);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const finishUpdate = createDeferred<void>();
    const active: {
      dispatchStartedAt?: number;
      lifecycle?: NonNullable<ReturnType<typeof getTelegramSpooledReplayLifecycle>>;
    } = {};
    await spoolUpdate(telegramMessageUpdate(39, "stalled"));
    handleUpdateSpy.mockImplementationOnce(async () => {
      active.dispatchStartedAt = Date.now();
      active.lifecycle = getTelegramSpooledReplayLifecycle();
      await finishUpdate.promise;
    });

    const started = await startScopedWebhook();
    try {
      await waitForWebhookState(() => expect(active.lifecycle).toBeDefined());
      const { dispatchStartedAt, lifecycle } = active;
      if (!lifecycle || dispatchStartedAt === undefined) {
        throw new Error("expected active webhook ingress lifecycle");
      }
      expect(lifecycle.abortSignal.aborted).toBe(false);
      const remainingMs = timeoutMs - (Date.now() - dispatchStartedAt);
      expect(remainingMs).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(lifecycle.abortSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(lifecycle.abortSignal.aborted).toBe(true);
    } finally {
      finishUpdate.resolve();
      await started.stop();
    }
  });

  it("retries a timed-out webhook update before later same-lane updates", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const finishFirstUpdate = createDeferred<void>();
    const finishRetry = createDeferred<void>();
    const seenUpdateIds: number[] = [];
    await spoolUpdate(telegramMessageUpdate(40, "slow"));
    await spoolUpdate(telegramMessageUpdate(41, "blocked"));
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      const updateId = (update as { update_id: number }).update_id;
      seenUpdateIds.push(updateId);
      if (updateId === 40) {
        await (
          seenUpdateIds.filter((id) => id === 40).length === 1 ? finishFirstUpdate : finishRetry
        ).promise;
      }
    });

    const started = await startScopedWebhook();
    try {
      await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40]));
      await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_ADOPTION_STALL_MS + 10_000);
      await yieldWebhookTask();
      expect(seenUpdateIds).toEqual([40]);

      finishFirstUpdate.resolve();
      await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40]));
      finishRetry.resolve();
      await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40, 41]));
    } finally {
      finishFirstUpdate.resolve();
      finishRetry.resolve();
      await started.stop();
    }
  });

  it.each([
    [false, "telegram:1234:topic:42", "telegram:1234"],
    [true, "telegram:1234", "telegram:1234:topic:42"],
  ] as const)(
    "replays acknowledged legacy DM lanes after restart when topic capability is %s",
    async (topicsEnabled, persistedLaneKey, canonicalLaneKey) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const firstUpdate = privateMessage(130, "accepted before restart", 1, 42);
      const secondUpdate = privateMessage(
        131,
        "accepted after the first event",
        2,
        topicsEnabled ? 42 : undefined,
      );
      await spoolUpdate(firstUpdate, persistedLaneKey);
      await spoolUpdate(secondUpdate, canonicalLaneKey);
      expect((await webhookQueue().listPending()).map((record) => record.laneKey)).toEqual([
        persistedLaneKey,
        canonicalLaneKey,
      ]);
      await closeStateDatabase();

      const { seenUpdateIds, firstUpdateStarted, firstUpdateCompleted } = holdWebhookUpdate(
        firstUpdate.update_id,
      );

      try {
        await withWebhook(async ({ ingress }) => {
          await firstUpdateStarted.promise;
          await ingress.waitForPumpIdle();
          expect(seenUpdateIds).toEqual([130]);

          firstUpdateCompleted.resolve();
          await ingress.waitForIdle();
          expect(seenUpdateIds).toEqual([130, 131]);
          expect(await pendingUpdates()).toEqual([]);
          expect(await webhookQueue().listFailed?.()).toEqual([]);
          expect(handleUpdateSpy).toHaveBeenCalledTimes(2);
        });
      } finally {
        firstUpdateCompleted.resolve();
      }
    },
  );

  it.each([
    ["exec", "telegram:1234:topic:42", 1234, "private", true, false],
    ["plugin", "telegram:1234:topic:42", 1234, "private", true, false],
    ["exec", "telegram:1234", 1234, "private", false, false],
    ["exec", "telegram:-1234", -1234, "group", false, false],
    ["exec", "telegram:-1001234", -1001234, "supergroup", false, false],
    ["exec", "telegram:-1001234:topic:42", -1001234, "supergroup", true, true],
    ["exec", "telegram:-1001234:topic:1", -1001234, "supergroup", false, true],
  ] as const)(
    "replays typed %s approvals from %s in their privileged lane",
    async (approvalKind, persistedLaneKey, expectedChatId, chatType, hasThread, isForum) => {
      const callback = createTelegramPrivateTopicCallback(142, webhookBotInfo.id);
      const update = {
        update_id: 142,
        callback_query: {
          ...callback,
          data: approvalData(approvalKind, "allow-once"),
          message: {
            ...callback.message,
            chat: { id: expectedChatId, type: chatType, ...(isForum ? { is_forum: true } : {}) },
            ...(hasThread ? {} : { message_thread_id: undefined }),
          },
        },
      };
      await spoolUpdate(update, persistedLaneKey);
      await closeStateDatabase();

      handleUpdateSpy.mockImplementationOnce(async () => {
        expect(await webhookQueue().listClaims()).toMatchObject([
          { laneKey: `telegram:${expectedChatId}:approval` },
        ]);
      });

      await expectReplayed(update);
    },
  );

  it.each([
    [false, "telegram:1234:topic:42"],
    [true, "telegram:1234"],
  ] as const)(
    "replays legitimate private callbacks after a topic-capability transition (%s)",
    async (topicsEnabled, persistedLaneKey) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const update = {
        update_id: 140,
        callback_query: createTelegramPrivateTopicCallback(140, webhookBotInfo.id),
      };
      await spoolUpdate(update, persistedLaneKey);
      await closeStateDatabase();

      await expectReplayed(update);
    },
  );

  const allowExec = approvalData("exec", "allow-once");
  const denyPlugin = approvalData("plugin", "deny");
  it.each([
    ["a bot callback sender", { from: { is_bot: true } }],
    ["an invalid callback sender", { from: { id: 0 } }],
    ["a foreign bot-authored message", { message: { from: { id: 999 } } }],
    ["an inaccessible callback message", { message: { date: 0 } }],
    ["an independent business chat", { message: { business_connection_id: "business-1234" } }],
    ["an independent guest chat", { message: { guest_query_id: "guest-1234" } }],
    [
      "a message sent by another chat",
      { message: { sender_chat: { id: -1234, type: "channel" } } },
    ],
    [
      "a direct-messages topic from another surface",
      { message: { direct_messages_topic: { topic_id: 42 } } },
    ],
    ["an inline callback message", { inline_message_id: "inline-message-141" }],
    ["an oversized callback payload", { data: "x".repeat(65) }],
    ["a missing chat instance", { chat_instance: "" }],
    ["a reserved question callback", { data: "tgq1:ask_0123456789abcdef0123456789abcdef:1" }],
    ["a reserved approval callback", { data: "/approve exec:def456 deny" }],
    ["a malformed signed approval decision", { data: allowExec?.replace(":o:", ":z:") }],
    ["a malformed signed approval kind", { data: allowExec?.replace(":e:", ":x:") }],
    [
      "a signed approval missing its canonical identifier",
      { data: denyPlugin?.replace(/signed-approval$/, "") },
    ],
    [
      "a signed approval in another business namespace",
      {
        data: allowExec,
        message: { business_connection_id: "business-1234" },
      },
    ],
    [
      "a signed approval in another guest namespace",
      { data: denyPlugin, message: { guest_query_id: "guest-1234" } },
    ],
    ["a signed approval from a foreign bot", { data: allowExec, message: { from: { id: 999 } } }],
    ["a signed approval from an invalid actor", { data: denyPlugin, from: { id: 0 } }],
    [
      "an inline signed approval",
      {
        data: allowExec,
        inline_message_id: "inline-message-141",
        inlineOnly: true,
      },
    ],
    ["a signed approval for another chat", { data: allowExec, message: { chat: { id: 9999 } } }],
    ["an ordinary callback without a topic", { message: { message_thread_id: undefined } }],
  ] as const)("does not authorize durable-lane reconciliation for %s", async (_name, patch) => {
    const laneKey = "telegram:1234:topic:42";
    await spoolUpdate(
      {
        update_id: 141,
        callback_query: patchedCallback(patch),
      },
      laneKey,
    );
    await closeStateDatabase();

    await expectInvalidLane(laneKey);
  });

  it.each(["telegram:9999:topic:42", "telegram:1234:topic:99", "telegram:1234:control"])(
    "rejects persisted DM lanes outside the signed upgrade contract (%s)",
    async (laneKey) => {
      await spoolUpdate(privateMessage(132, "reject mismatched durable identity", 1, 42), laneKey);
      await closeStateDatabase();

      await withWebhook(async ({ ingress }) => {
        await ingress.waitForIdle();
        expect(
          await webhookQueue().listFailed?.({
            limit: "all",
          }),
        ).toMatchObject([{ reason: "invalid-event", laneKey }]);
        expect(handleUpdateSpy).not.toHaveBeenCalled();
        expect(await pendingUpdates()).toEqual([]);
      });
    },
  );

  it("leaves another account's pending ingress untouched", async () => {
    await spoolUpdate(telegramMessageUpdate(133, "other account pending"));
    const ownUpdate = telegramMessageUpdate(134, "this account receives");
    const delivered = createDeferred<void>();
    handleUpdateSpy.mockImplementationOnce(() => delivered.resolve());

    await withWebhook(
      async ({ port }) => {
        const response = await postUpdate(port, ownUpdate);
        expect(response.status).toBe(200);
        await delivered.promise;
        expect(handleUpdateSpy).toHaveBeenCalledWith(ownUpdate);
        expect(handleUpdateSpy).toHaveBeenCalledOnce();
        expect(await pendingUpdates()).toMatchObject([{ updateId: 133 }]);
        expect(await webhookQueue().listClaims()).toEqual([]);
      },
      { accountId: "other" },
    );
  });

  const legacyTopicMessage = {
    chat: { id: 1234, type: "private" },
    message_id: 1,
    message_thread_id: 42,
  };
  it.each([
    {
      name: "a malformed callback query",
      update: {
        update_id: 134,
        callback_query: {
          data: "unrecognized-callback",
          message: legacyTopicMessage,
        },
      },
    },
    {
      name: "a group message",
      update: {
        update_id: 135,
        message: {
          ...legacyTopicMessage,
          chat: { id: 1234, type: "group" },
          text: "wrong chat kind",
        },
      },
    },
  ])("rejects legacy lane reconciliation for $name", async ({ update }) => {
    const laneKey = "telegram:1234:topic:42";
    await spoolUpdate(update, laneKey);
    await closeStateDatabase();

    await expectInvalidLane(laneKey);
  });

  it("stops claimed completion retries when the webhook stops", async () => {
    vi.useFakeTimers();
    let completeAttempts = 0;
    setTelegramRuntime({
      channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
      state: {
        resolveStateDir: () => webhookStateDir ?? os.tmpdir(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
          return {
            ...queue,
            complete: async () => {
              completeAttempts += 1;
              throw new Error("persistent completion write failure");
            },
          };
        },
      },
    } as unknown as TelegramRuntime);
    await spoolUpdate(telegramMessageUpdate(52, "stop retry"));
    const retryScheduled = createDeferred<void>();
    const runtimeLog = vi.fn((message: unknown) => {
      if (
        typeof message === "string" &&
        /completion retry 1 scheduled|tombstone retry 1\//.test(message)
      ) {
        retryScheduled.resolve();
      }
    });
    const started = await startScopedWebhook({ runtime: testRuntime(runtimeLog) });

    try {
      await retryScheduled.promise;
      await started.stop();
      const attemptsAfterStop = completeAttempts;
      await vi.advanceTimersByTimeAsync(400);

      // Stop must abort in-flight tombstone retries (composed webhookAbortSignal).
      expect(completeAttempts).toBe(attemptsAfterStop);
    } finally {
      await started.stop();
    }
  });

  it("returns non-200 when the webhook update cannot be spooled durably", async () => {
    await withWebhook(async ({ port }) => {
      const response = await postUpdate(port, {
        callback_query: createTelegramPrivateTopicCallback(33, webhookBotInfo.id),
      });

      expect({
        status: response.status,
        accepted: response.headers.get("x-openclaw-delivery-accepted"),
      }).toEqual({ status: 500, accepted: null });
      expect(answerCallbackQuerySpy).not.toHaveBeenCalled();
      expect(handleUpdateSpy).not.toHaveBeenCalled();
    });
  });

  it("rejects unauthenticated requests before reading the request body", async () => {
    await withWebhook(async ({ port }) => {
      const response = await postWebhookHeadersOnly({
        port,
        path: TELEGRAM_WEBHOOK_PATH,
        declaredLength: 1_024 * 1_024,
        secret: "wrong-secret",
      });

      expect(response).toEqual({ statusCode: 401, body: "unauthorized" });
      expect(handleUpdateSpy).not.toHaveBeenCalled();
    });
  });

  it("rate limits repeated invalid secret guesses without throttling authenticated delivery", async () => {
    await withWebhook(async ({ port }) => {
      let saw429 = false;

      for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
        const response = await postUpdate(port, {}, `wrong-secret-${String(i).padStart(3, "0")}`);

        if (response.status === 429) {
          saw429 = true;
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
          expect(await response.text()).toBe("Too Many Requests");
          break;
        }

        expect(response.status).toBe(401);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        expect(await response.text()).toBe("unauthorized");
      }

      expect(saw429).toBe(true);

      const validResponse = await postUpdate(port, telegramMessageUpdate(999, "hello"));
      await expectAccepted(validResponse);
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
    });
  });

  it("does not rate limit authenticated webhook request storms", async () => {
    await withWebhook(async ({ port }) => {
      for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
        const response = await postUpdate(port, telegramMessageUpdate(10_000 + i, `valid ${i}`));
        expect(response.status).toBe(200);
      }
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalled());
    });
  });

  it.each([
    ["untrusted loopback hops", "127.0.0.1", ", 127.0.0.2", 401],
    ["ignored bracketed proxy entries", "[127.0.0.1]", "", 429],
  ] as const)(
    "isolates legacy auth budgets and preserves %s across account restarts",
    async (_name, trustedProxy, suffix, otherHopStatus) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const endpoint = { port: 9000, host: "127.0.0.1" };
      const base = {
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        ...requireWebhookQueueScope(),
        config: { gateway: { trustedProxies: [trustedProxy] } },
      };
      let first = await startTelegramWebhook({
        ...base,
        accountId: "first",
        legacyWebhook: endpoint,
      });
      const secondEndpoint = { ...endpoint, port: 9001 };
      let second: typeof first | undefined;
      let shared: typeof first | undefined;
      const denied = { status: 429, body: "Too Many Requests", accepted: null };
      const accepted = { status: 200, body: "", accepted: "durable" };
      let updateId = 899;
      const request = async (forwarded: string, secret = "wrong-secret") => {
        const response = await fetch(
          webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH),
          {
            method: "POST",
            headers: { "x-telegram-bot-api-secret-token": secret, "x-forwarded-for": forwarded },
            body: JSON.stringify(telegramMessageUpdate(updateId++, "legacy budget")),
          },
        );
        return {
          status: response.status,
          body: await response.text(),
          accepted: response.headers.get("x-openclaw-delivery-accepted"),
        };
      };
      try {
        second = await startTelegramWebhook({
          ...base,
          accountId: "second",
          legacyWebhook: secondEndpoint,
        });
        legacyListenerForRequest.mockReturnValue(endpoint);
        for (let index = 1; index <= 120; index += 1) {
          expect((await request(`198.51.100.${index}${suffix}`)).status).toBe(401);
        }
        expect(await request(`203.0.113.1${suffix}`)).toEqual(denied);
        shared = await startTelegramWebhook({
          ...base,
          accountId: "shared",
          secret: "shared-secret",
          legacyWebhook: endpoint,
        });
        expect(await request(`203.0.113.1${suffix}`)).toEqual(denied);
        expect((await request("203.0.113.1, 127.0.0.3")).status).toBe(otherHopStatus);
        expect(await request(`203.0.113.1${suffix}`, "shared-secret")).toEqual(accepted);
        expect(await request(`203.0.113.1${suffix}`, TELEGRAM_SECRET)).toEqual(accepted);

        legacyListenerForRequest.mockReturnValue(secondEndpoint);
        expect((await request(`203.0.113.1${suffix}`)).status).toBe(401);
        legacyListenerForRequest.mockReturnValue(undefined);
        expect((await request(`203.0.113.1${suffix}`)).status).toBe(401);

        await shared.stop();
        await first.stop();
        first = await startTelegramWebhook({
          ...base,
          accountId: "first",
          legacyWebhook: endpoint,
        });
        legacyListenerForRequest.mockReturnValue(endpoint);
        expect((await request(`203.0.113.1${suffix}`)).status).toBe(401);
      } finally {
        await first.stop();
        await second?.stop();
        await shared?.stop();
      }
    },
  );

  it("rejects startup when webhook secret is missing", async () => {
    await expect(startTelegramWebhook({ token: "tok" })).rejects.toThrow(
      /requires a non-empty secret token/i,
    );
  });

  it.each([
    { path: "/hook?token=known", legacyWebhook: false as const },
    { path: "/ready/webhook", legacyWebhook: false as const },
    { path: "/readyz?token=known", legacyWebhook: { port: 8787, host: "127.0.0.1" } },
    { path: "/healthz?token=known", legacyWebhook: { port: 8787, host: "127.0.0.1" } },
    { path: "/%61pi/channels/telegram", legacyWebhook: { port: 8787, host: "127.0.0.1" } },
  ])("preserves exact webhook target $path", async ({ path, legacyWebhook }) => {
    await withWebhook(
      async ({ port }) => {
        legacyListenerForRequest.mockReturnValue(
          legacyWebhook === false ? undefined : legacyWebhook,
        );
        const accepted = await postUpdate(
          webhookUrl(port, path),
          telegramMessageUpdate(807, "exact route"),
        );
        expect(accepted.status).toBe(200);
        const rejected = await postUpdate(
          webhookUrl(port, `${path}${path.includes("?") ? "&" : "?"}changed=true`),
          telegramMessageUpdate(808, "wrong route"),
        );
        expect(rejected.status).toBe(404);
      },
      { secret: TELEGRAM_SECRET, path, legacyWebhook },
    );
  });

  it.each(telegramWebhookListenerCases)(
    "registers the public URL with $name legacy listener",
    async ({ legacyWebhook, endpoint, publicUrl, advertisedUrl }) => {
      const runtimeLog = vi.fn();
      await withWebhook(
        async ({ port }) => {
          expect(gateway.registry.httpRoutes[0]?.legacyListeners).toEqual(
            endpoint ? [{ ...endpoint, health: { path: "/healthz" } }] : undefined,
          );
          expect(port).toBeGreaterThan(0);
          expect(setWebhookSpy).toHaveBeenCalledTimes(1);
          const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
          expect(setWebhookCall).toEqual([
            advertisedUrl,
            expect.objectContaining({ secret_token: TELEGRAM_SECRET }),
          ]);
          expect(runtimeLog).toHaveBeenCalledWith(
            `telegram webhook Gateway route ${TELEGRAM_WEBHOOK_PATH} (port 18789)`,
          );
        },
        {
          legacyWebhook,
          publicUrl,
          config: { gateway: { publicOrigin: "https://gateway.example.test" } },
          runtime: testRuntime(runtimeLog),
        },
      );
    },
  );

  it.each([
    { topicsEnabled: false, shouldSerialize: true },
    { topicsEnabled: true, shouldSerialize: false },
  ])(
    "matches DM session serialization to initialized bot topic capability ($topicsEnabled)",
    async ({ topicsEnabled, shouldSerialize }) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const { seenUpdateIds, firstUpdateCompleted } = holdWebhookUpdate(100);

      await withWebhook(async ({ port }) => {
        const url = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
        const firstUpdate = privateMessage(100, "first");
        const secondUpdate = privateMessage(101, "second", 2, 42);

        try {
          expect((await postUpdate(url, firstUpdate)).status).toBe(200);
          await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100]));

          expect((await postUpdate(url, secondUpdate)).status).toBe(200);

          if (shouldSerialize) {
            await sleep(25);
            expect(seenUpdateIds).toEqual([100]);
          } else {
            await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100, 101]));
          }
        } finally {
          firstUpdateCompleted.resolve();
        }

        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100, 101]));
      });
    },
  );

  it("handles near-limit payload with random chunk writes and event-loop yields", async () => {
    const seenUpdates: TestTelegramMessageUpdate[] = [];
    handleUpdateSpy.mockImplementationOnce((update: unknown) => {
      seenUpdates.push(update as TestTelegramMessageUpdate);
    });

    const { payload, sizeBytes } = createNearLimitTelegramPayload();
    expect(sizeBytes).toBeLessThan(1_024 * 1_024);
    expect(sizeBytes).toBeGreaterThan(256 * 1_024);
    const expected = JSON.parse(payload) as TestTelegramMessageUpdate;

    await withWebhook(async ({ port, ingress }) => {
      const response = await postWebhookPayloadWithChunkPlan({
        port,
        path: TELEGRAM_WEBHOOK_PATH,
        payload,
        secret: TELEGRAM_SECRET,
        mode: "random-chunked",
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      // The 200 means durable admission; dispatch reads the ~1 MB row back from
      // SQLite afterward, so join the drain instead of polling a wall-clock budget.
      await ingress.waitForIdle();
      expectSingleNearLimitUpdate({ seenUpdates, expected });
    });
  });

  it("rejects payloads larger than 1MB before invoking webhook handler", async () => {
    await withWebhook(async ({ port }) => {
      const responseOrError = await postWebhookWithDeclaredLength({
        port,
        path: TELEGRAM_WEBHOOK_PATH,
        secret: TELEGRAM_SECRET,
        declaredLength: 1_024 * 1_024 + 2_048,
        body: "{}",
      });

      expect(responseOrError).toEqual({
        kind: "response",
        statusCode: 413,
        body: "Payload too large",
      });
      expect(handleUpdateSpy).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
