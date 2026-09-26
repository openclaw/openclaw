import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import { monitorTelegramProvider } from "./monitor.js";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";
import {
  writeTelegramSpooledUpdate,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
} from "./telegram-ingress-spool.test-support.js";
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

const legacyListenerForRequest = vi.hoisted(() =>
  vi.fn((): { port: number; host?: string } | undefined => undefined),
);
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: legacyListenerForRequest,
}));

const handleUpdateSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const answerCallbackQuerySpy = vi.hoisted(() => vi.fn(async () => true));
const setWebhookSpy = vi.hoisted(() => vi.fn());
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
const createTelegramBotSpy = vi.hoisted(() =>
  vi.fn(() => ({
    init: initSpy,
    botInfo: webhookBotInfo,
    handleUpdate: handleUpdateSpy,
    api: {
      setWebhook: setWebhookSpy,
      deleteWebhook: deleteWebhookSpy,
      answerCallbackQuery: answerCallbackQuerySpy,
    },
    stop: stopSpy,
  })),
);
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
const TELEGRAM_WEBHOOK_RATE_LIMIT_BURST = WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests + 10;

vi.mock("grammy", async () => {
  const actual = await vi.importActual<typeof import("grammy")>("grammy");
  return {
    ...actual,
    API_CONSTANTS: actual.API_CONSTANTS ?? {
      DEFAULT_UPDATE_TYPES: ["message"],
      ALL_UPDATE_TYPES: ["message"],
    },
    InputFile:
      actual.InputFile ??
      class InputFile {
        constructor(public readonly path: string) {}
      },
    GrammyError:
      actual.GrammyError ??
      class GrammyError extends Error {
        description = "";
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
  withWebhook: withStartedWebhook,
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

function resetTelegramWebhookMocks(): void {
  legacyListenerForRequest.mockReset().mockReturnValue(undefined);
  handleUpdateSpy.mockReset();
  handleUpdateSpy.mockImplementation((..._args: unknown[]): unknown => undefined);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockImplementation(async () => true);

  setWebhookSpy.mockReset();
  deleteWebhookSpy.mockReset();
  deleteWebhookSpy.mockImplementation(async () => true);
  initSpy.mockReset();
  initSpy.mockImplementation(async () => undefined);
  stopSpy.mockReset();
  resolveTelegramTransportSpy.mockClear();
  transportCloseSpies.length = 0;
  webhookBotInfo.has_topics_enabled = false;
  createTelegramBotSpy.mockReset();
  createTelegramBotSpy.mockImplementation(() => ({
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
}

beforeAll(() => gateway.listen());
afterAll(() => gateway.close());

beforeEach(async () => {
  gateway.resetRegistry();
  resetTelegramWebhookMocks();
  webhookStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-telegram-webhook-"));
  installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir());
});

afterEach(async () => {
  vi.useRealTimers();
  const stateDir = webhookStateDir;
  try {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  } finally {
    vi.unstubAllEnvs();
    clearTelegramRuntime();
    webhookStateDir = undefined;
  }
});

async function runNearLimitPayloadTestAndExpectUpdate(
  mode: "single" | "random-chunked",
): Promise<void> {
  const seenUpdates: TestTelegramMessageUpdate[] = [];
  handleUpdateSpy.mockImplementationOnce((update: unknown) => {
    seenUpdates.push(update as TestTelegramMessageUpdate);
  });

  const { payload, sizeBytes } = createNearLimitTelegramPayload();
  expect(sizeBytes).toBeLessThan(1_024 * 1_024);
  expect(sizeBytes).toBeGreaterThan(256 * 1_024);
  const expected = JSON.parse(payload) as TestTelegramMessageUpdate;

  await withStartedWebhook(
    {
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
    },
    async ({ port }) => {
      const response = await postWebhookPayloadWithChunkPlan({
        port,
        path: TELEGRAM_WEBHOOK_PATH,
        payload,
        secret: TELEGRAM_SECRET,
        mode,
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      await waitForWebhookState(() => expectSingleNearLimitUpdate({ seenUpdates, expected }));
    },
  );
}

describe("startTelegramWebhook", () => {
  it.each([
    { binding: "standalone", enabled: false },
    { binding: "standalone", enabled: true },
    { binding: "unrelated", enabled: false },
    { binding: "late", enabled: false },
    { binding: "runtime", enabled: false },
    { binding: "source", enabled: false },
  ] as const)(
    "respects $binding diagnostics (enabled=$enabled) and preserves the host heartbeat",
    async ({ binding, enabled }) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const events: string[] = [];
      const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
      startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
      const config = { diagnostics: { enabled } };
      const followsRuntime = binding === "runtime" || binding === "source";
      if (followsRuntime) {
        setRuntimeConfigSnapshot(binding === "runtime" ? config : { ...config }, config);
      } else if (binding === "unrelated") {
        setRuntimeConfigSnapshot(
          { diagnostics: { enabled: true } },
          { logging: { level: "debug" } },
        );
      }
      try {
        await withStartedWebhook(
          {
            secret: TELEGRAM_SECRET,
            path: TELEGRAM_WEBHOOK_PATH,
            config: binding === "source" ? structuredClone(config) : config,
          },
          async ({ port, server }) => {
            if (binding === "late") {
              setRuntimeConfigSnapshot({ diagnostics: { enabled: true } });
            }
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
  it("registers the Gateway route and advertises the configured webhook", async () => {
    initSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const runtimeLog = vi.fn();
    const setStatus = vi.fn();
    const cfg = { bindings: [] };
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        accountId: "opie",
        ownerAgentId: "ops",
        config: cfg,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        setStatus,
      },
      async ({ port }) => {
        const botParams = requireRecord(
          requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
          "createTelegramBot params",
        );
        expect(botParams.accountId).toBe("opie");
        expect(botParams.ownerAgentId).toBe("ops");
        expect(requireRecord(botParams.config, "telegram config").bindings).toEqual([]);
        expect(botParams.telegramTransport).toBeDefined();
        const notFound = await fetch(`http://127.0.0.1:${port}/not-the-webhook`);
        expect(notFound.status).toBe(404);
        expect(notFound.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(setWebhookSpy).toHaveBeenCalled();
        const registration = requireRecord(
          requireMockCall(setWebhookSpy, 0, "setWebhook")[1],
          "webhook registration",
        );
        expect(registration.allowed_updates).toEqual(
          expect.arrayContaining(["message_reaction", "channel_post"]),
        );
        expect(registration.allowed_updates).not.toContain("stopped_message_generation");
        expectMockMessageContains(runtimeLog, "telegram webhook Gateway route");
        expectMockMessageContains(runtimeLog, "/telegram-webhook");
        expectMockMessageContains(runtimeLog, "webhook advertised to telegram on http://");
        expect(setStatus).toHaveBeenNthCalledWith(1, {
          mode: "webhook",
          connected: false,
          lastConnectedAt: null,
          lastEventAt: null,
          lastTransportActivityAt: null,
        });
        const connectedStatus = requireRecord(
          requireMockCall(setStatus, 1, "setStatus")[0],
          "connected status",
        );
        expect(connectedStatus.mode).toBe("webhook");
        expect(connectedStatus.connected).toBe(true);
        expect(connectedStatus.running).toBe(true);
        expect(connectedStatus).toHaveProperty("terminalDisconnect", undefined);
        expect(typeof connectedStatus.lastConnectedAt).toBe("number");
        expect(typeof connectedStatus.lastEventAt).toBe("number");
        expect(connectedStatus.lifecycle).toBe("ready");
        expect(connectedStatus.lastError).toBeNull();
      },
    );
  });

  it.each([
    { name: "omitted host", configured: { port: 8787 }, host: "127.0.0.1" },
    { name: "explicit wildcard", configured: { port: 8787, host: "0.0.0.0" }, host: "0.0.0.0" },
    { name: "explicit address", configured: { port: 8787, host: "127.0.0.2" }, host: "127.0.0.2" },
  ])(
    "prepares the legacy listener for $name and accepts its signed callback",
    async ({ configured, host }) => {
      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
          legacyWebhook: configured,
        },
        async ({ port }) => {
          const endpoint = { port: 8787, host };
          expect(gateway.registry.httpRoutes[0]?.legacyListeners).toEqual([
            { ...endpoint, health: { path: "/healthz" } },
          ]);
          legacyListenerForRequest.mockReturnValue(endpoint);
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify(telegramMessageUpdate(809, "legacy bind address")),
            secret: TELEGRAM_SECRET,
          });
          expect(response.status).toBe(200);
        },
      );
    },
  );

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
      const url = webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH);
      const accepted = await postWebhookJson({
        url,
        payload: JSON.stringify(telegramMessageUpdate(801, "second account")),
        secret: "second-secret",
      });
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
        const rejected = await postWebhookJson({
          url,
          payload: JSON.stringify(telegramMessageUpdate(802, "ambiguous account")),
          secret: "second-secret",
        });
        expect(rejected.status).toBe(401);
        legacyListenerForRequest.mockReturnValue({ port: 8787, host: "127.0.0.1" });
        statusB.mockClear();
        const legacyAccepted = await postWebhookJson({
          url,
          payload: JSON.stringify(telegramMessageUpdate(804, "legacy account")),
          secret: "second-secret",
        });
        expect(legacyAccepted.status).toBe(200);
        expect(statusB).toHaveBeenCalled();
        legacyListenerForRequest.mockReturnValue({ port: 8789, host: "127.0.0.1" });
        const wrongEndpoint = await postWebhookJson({
          url,
          payload: JSON.stringify(telegramMessageUpdate(805, "wrong legacy endpoint")),
          secret: "second-secret",
        });
        expect(wrongEndpoint.status).toBe(404);
      } finally {
        legacyListenerForRequest.mockReturnValue(undefined);
        await ambiguous.stop();
      }
      await first.stop();
      expect(gateway.registry.httpRoutes).toHaveLength(1);
      const remaining = await postWebhookJson({
        url,
        payload: JSON.stringify(telegramMessageUpdate(803, "remaining account")),
        secret: "second-secret",
      });
      expect(remaining.status).toBe(200);
    } finally {
      await first.stop();
      await second.stop();
    }
    expect(gateway.registry.httpRoutes).toHaveLength(0);
  });

  it("aborts bot fetches and account-owned work when the webhook stops", async () => {
    const callerAbort = new AbortController();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      abortSignal: callerAbort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
    });

    try {
      const botParams = requireRecord(
        requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
        "createTelegramBot params",
      );
      const fetchAbortSignal = botParams.fetchAbortSignal;
      const accountAbortSignal = botParams.accountAbortSignal;
      expect(fetchAbortSignal).toBeInstanceOf(AbortSignal);
      expect(accountAbortSignal).toBeInstanceOf(AbortSignal);
      if (
        !(fetchAbortSignal instanceof AbortSignal) ||
        !(accountAbortSignal instanceof AbortSignal)
      ) {
        throw new Error("expected bot fetch and account abort signals");
      }
      const fetchAborted = new Promise<void>((resolve) => {
        fetchAbortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      const accountAborted = new Promise<void>((resolve) => {
        accountAbortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      await started.stop();

      await expect(Promise.all([fetchAborted, accountAborted])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(callerAbort.signal.aborted).toBe(false);
    } finally {
      await started.stop();
      callerAbort.abort();
    }
  });

  it("keeps the Gateway route registered and retries when setWebhook has a recoverable startup failure", async () => {
    const advertised = createDeferred<void>();
    const runtimeLog = vi.fn((message: unknown) => {
      if (typeof message === "string" && message.startsWith("webhook advertised to telegram on ")) {
        advertised.resolve();
      }
    });
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    setWebhookSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(true);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
        setStatus,
        webhookRegistrationRetryPolicy: {
          initialMs: 0,
          maxMs: 0,
          factor: 1,
          jitter: 0,
        },
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
          secret: TELEGRAM_SECRET,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(stopSpy).not.toHaveBeenCalled();
        expectMockMessageContains(runtimeError, "telegram setWebhook failed: fetch failed");
        await advertised.promise;
        expect(setWebhookSpy).toHaveBeenCalledTimes(2);
        expect(runtimeLog).toHaveBeenCalledWith("telegram setWebhook retry 1 scheduled in 0ms");
        expectMockMessageContains(runtimeLog, "webhook advertised to telegram on http://");
        expect(setStatus).toHaveBeenCalledWith({
          mode: "webhook",
          connected: false,
          lifecycle: "recovering",
          lastError: "fetch failed",
        });
        expectStatusCall(setStatus, { mode: "webhook", connected: true, lastError: null });
      },
    );
  });

  it("fails startup when setWebhook has a non-recoverable rejection", async () => {
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    const error = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy.mockRejectedValueOnce(error);

    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
        setStatus,
      }),
    ).rejects.toThrow("unauthorized");

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    expectMockMessageContains(runtimeError, "telegram setWebhook failed: unauthorized");
    expectStatusCall(setStatus, {
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "unauthorized",
    });
  });

  it("does not mark a non-auth setWebhook rejection as blocked", async () => {
    const setStatus = vi.fn();
    const error = Object.assign(new Error("bad webhook URL"), { error_code: 400 });
    setWebhookSpy.mockRejectedValueOnce(error);

    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        setStatus,
      }),
    ).rejects.toThrow("bad webhook URL");

    const failedStatus = expectStatusCall(setStatus, { lastError: "bad webhook URL" });
    expect(failedStatus.lifecycle).toBeUndefined();
  });

  it("releases the Gateway route and stops the bot when retry loop encounters a non-recoverable error", async () => {
    const runtimeError = vi.fn();
    const stopped = createDeferred<void>();
    const setStatus = vi.fn((patch: { mode?: string; connected?: boolean }) => {
      if (
        patch.mode === "webhook" &&
        patch.connected === false &&
        Object.keys(patch).length === 2
      ) {
        stopped.resolve();
      }
    });
    const unauthorizedError = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(unauthorizedError);

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      setStatus,
      webhookRegistrationRetryPolicy: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
      },
    });

    try {
      await stopped.promise;
      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
      expectStatusCall(setStatus, {
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "unauthorized",
      });
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
      expectMockMessageContains(
        runtimeError,
        "telegram setWebhook retry stopped after non-recoverable error",
      );

      await started.stop();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    } finally {
      await started.stop();
    }
  });

  it("retries transient getMe startup init failures before starting the account", async () => {
    const runtimeLog = vi.fn();
    const setStatus = vi.fn();
    initSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(undefined);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        setStatus,
        webhookRegistrationRetryPolicy: {
          initialMs: 0,
          maxMs: 0,
          factor: 1,
          jitter: 0,
        },
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
          secret: TELEGRAM_SECRET,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      },
    );

    expect(initSpy).toHaveBeenCalledTimes(2);
    expect(runtimeLog).toHaveBeenCalledWith("telegram getMe retry 1 scheduled in 0ms");
    expectStatusCall(setStatus, { lifecycle: "recovering" });
    expect(setWebhookSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves the initialization failure when bot shutdown also fails", async () => {
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    const initializationError = Object.assign(new Error("unauthorized"), { error_code: 401 });
    initSpy.mockRejectedValueOnce(initializationError);
    stopSpy.mockRejectedValueOnce(new Error("bot stop failed"));

    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        ...requireWebhookQueueScope(),
        runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
        setStatus,
      }),
    ).rejects.toBe(initializationError);

    expect(setWebhookSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    expect(deleteWebhookSpy).not.toHaveBeenCalled();
    expectWebhookBotScopesAborted(createTelegramBotSpy);
    expectMockMessageContains(runtimeError, "telegram webhook bot stop failed: bot stop failed");
    expectStatusCall(setStatus, { lifecycle: "blocked", lastError: "unauthorized" });
  });

  it("releases startup resources when another plugin owns its Gateway route", async () => {
    gateway.registry.httpRoutes.push({
      path: TELEGRAM_WEBHOOK_PATH,
      pluginId: "other",
      auth: "plugin",
      match: "exact",
      handler: () => true,
    });
    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        ...requireWebhookQueueScope(),
      }),
    ).rejects.toThrow(/route reuse denied/);
    expect(setWebhookSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    expectWebhookBotScopesAborted(createTelegramBotSpy);
  });

  it("releases an advertised route when opening its durable ingress queue fails", async () => {
    const abort = new AbortController();
    const setStatus = vi.fn();
    const queueError = new Error("state database unavailable");
    installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir(), queueError);

    try {
      await expect(
        startTelegramWebhook({
          token: TELEGRAM_TOKEN,
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
          ...requireWebhookQueueScope(),
          abortSignal: abort.signal,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          setStatus,
        }),
      ).rejects.toBe(queueError);

      expect(setWebhookSpy).toHaveBeenCalledOnce();
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
      expect(deleteWebhookSpy).not.toHaveBeenCalled();
      expectWebhookBotScopesAborted(createTelegramBotSpy);
      expectStatusCall(setStatus, { lastError: "state database unavailable" });
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });

      expect(gateway.registry.httpRoutes).toHaveLength(0);
    } finally {
      abort.abort();
      expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    }
  });

  it("registers webhook with certificate when webhookCertPath is provided", async () => {
    setWebhookSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        webhookCertPath: "/path/to/cert.pem",
      },
      async () => {
        const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
        expect(typeof setWebhookCall[0]).toBe("string");
        const options = requireRecord(setWebhookCall[1], "setWebhook options");
        const certificate = options.certificate as
          | { path?: string; fileData?: string; filename?: string }
          | undefined;
        if (!certificate) {
          throw new Error("expected Telegram webhook certificate payload");
        }
        if (certificate && "path" in certificate && typeof certificate.path === "string") {
          expect(certificate.path).toBe("/path/to/cert.pem");
        } else {
          expect(certificate.fileData).toBe("/path/to/cert.pem");
          expect(certificate.filename).toBe("cert.pem");
        }
      },
    );
  });

  it("acks before webhook update processing finishes", async () => {
    const slowUpdate = telegramMessageUpdate(2, "slow");
    const setStatus = vi.fn();
    let finishWork: (() => void) | undefined;
    let workStarted = false;
    let workFinished = false;
    handleUpdateSpy.mockImplementationOnce(async (update: unknown) => {
      expect(update).toEqual(telegramMessageUpdate(2, "slow"));
      workStarted = true;
      await new Promise<void>((resolve) => {
        finishWork = resolve;
      });
      workFinished = true;
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        setStatus,
      },
      async ({ port }) => {
        setStatus.mockClear();
        const receivedAfter = Date.now();
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(slowUpdate),
          secret: TELEGRAM_SECRET,
          timeoutMs: 1_000,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(await response.text()).toBe("");
        await waitForWebhookState(() => expect(workStarted).toBe(true));
        expect(workFinished).toBe(false);
        const receivedStatus = expectStatusCall(setStatus, {
          mode: "webhook",
          running: true,
          connected: true,
          lifecycle: "ready",
          terminalDisconnect: undefined,
          lastError: null,
        });
        expect(receivedStatus.lastConnectedAt).toBeGreaterThanOrEqual(receivedAfter);
        expect(receivedStatus.lastEventAt).toBeGreaterThanOrEqual(receivedAfter);

        finishWork?.();
        await waitForWebhookState(() => expect(workFinished).toBe(true));
      },
    );
  });

  it("answers a durably admitted callback before its same-chat lane drains", async () => {
    const blockingUpdate = {
      update_id: 5,
      message: {
        message_id: 5,
        date: 1_736_380_800,
        from: { id: 111, is_bot: false, first_name: "Ada" },
        chat: { id: 1234, type: "private" },
        text: "slow",
      },
    };
    const callbackUpdate = {
      update_id: 6,
      callback_query: createTelegramPrivateTopicCallback(6, webhookBotInfo.id),
    };
    const seenUpdateIds: number[] = [];
    let releaseBlockingUpdate: (() => void) | undefined;
    const blockingUpdateCompleted = new Promise<void>((resolve) => {
      releaseBlockingUpdate = resolve;
    });
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      const updateId = (update as { update_id: number }).update_id;
      seenUpdateIds.push(updateId);
      if (updateId === blockingUpdate.update_id) {
        await blockingUpdateCompleted;
      }
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const url = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
        try {
          const blockingResponse = await postWebhookJson({
            url,
            payload: JSON.stringify(blockingUpdate),
            secret: TELEGRAM_SECRET,
          });
          expect(blockingResponse.status).toBe(200);
          await waitForWebhookState(() => expect(seenUpdateIds).toEqual([5]));

          const callbackResponse = await postWebhookJson({
            url,
            payload: JSON.stringify(callbackUpdate),
            secret: TELEGRAM_SECRET,
          });
          expect(callbackResponse.status).toBe(200);
          expect(callbackResponse.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(answerCallbackQuerySpy).toHaveBeenCalledWith("callback-6");
          expect(seenUpdateIds).toEqual([5]);
        } finally {
          releaseBlockingUpdate?.();
        }

        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([5, 6]));
      },
    );
  });

  it("bounds shutdown when a webhook handler ignores abort", async () => {
    let releaseWork: (() => void) | undefined;
    handleUpdateSpy.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseWork = resolve;
        }),
    );
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    try {
      const response = await postWebhookJson({
        url: webhookUrl(getServerPort(started.server), TELEGRAM_WEBHOOK_PATH),
        payload: JSON.stringify(telegramMessageUpdate(3, "stuck")),
        secret: TELEGRAM_SECRET,
      });
      expect(response.status).toBe(200);
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledOnce());

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopTask = started.stop();
      await vi.advanceTimersByTimeAsync(15_000);
      await stopTask;

      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    } finally {
      releaseWork?.();
      vi.useRealTimers();
      await started.stop();
    }
  });

  it("continues webhook shutdown after bot stop fails", async () => {
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    stopSpy.mockRejectedValueOnce(new Error("bot stop failed"));

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      setStatus,
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
    });

    await expect(started.stop()).resolves.toBeUndefined();

    expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
    expectMockMessageContains(runtimeError, "telegram webhook bot stop failed");
  });

  it("joins concurrent stops with abort-driven webhook cleanup", async () => {
    const stopEntered = createDeferred<void>();
    const finishStop = createDeferred<void>();
    stopSpy.mockImplementationOnce(() => {
      stopEntered.resolve();
      return finishStop.promise;
    });
    const abort = new AbortController();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      abortSignal: abort.signal,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
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
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update: telegramMessageUpdate(62, "not accepted"),
    });
    await monitorTelegramProvider({
      token: TELEGRAM_TOKEN,
      accountId: "test",
      config: {},
      useWebhook: true,
      webhookUrl: webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH),
      webhookPath: TELEGRAM_WEBHOOK_PATH,
      webhookSecret: TELEGRAM_SECRET,
      abortSignal: AbortSignal.abort(new Error("account stopped")),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(handleUpdateSpy).not.toHaveBeenCalled();
    expect(setWebhookSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    expect(
      (await listTelegramSpooledUpdates(requireWebhookQueueScope())).map((entry) => entry.updateId),
    ).toEqual([62]);
  });

  it.each(["commit", "rollback", "introduction"] as const)(
    "joins accepted %s beyond webhook provider shutdown grace",
    async (operation) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", webhookStateDir);
      const abort = new AbortController();
      const operationStarted = createDeferred<void>();
      const releaseOperation = createDeferred<void>();
      const recorded = new Set<string>();
      const setStatus = vi.fn();
      let settlement: Promise<void> | undefined;
      handleUpdateSpy.mockImplementationOnce(async () => {
        const participant = createTelegramSpooledReplayDeferredParticipant("held-webhook-work");
        const hold = participant?.beginSettlementHold();
        if (!participant || !hold) {
          throw new Error("Expected accepted webhook settlement ownership");
        }
        settlement = (async () => {
          try {
            if (operation === "introduction") {
              operationStarted.resolve();
              await releaseOperation.promise;
              recorded.add("introduction");
            } else {
              await commitTelegramMessageDispatchReplay({
                requirePersistent: true,
                guard: {
                  claim: async () => ({ kind: "invalid" }),
                  warmup: async () => 0,
                  forget: async (event) => {
                    operationStarted.resolve();
                    await releaseOperation.promise;
                    for (const key of "keys" in event ? (event.keys ?? []) : []) {
                      recorded.delete(key);
                    }
                    return true;
                  },
                },
                claims: ["first", "second"].map((key) => ({
                  keys: [key],
                  commit: async (options) => {
                    if (operation === "commit" && key === "first") {
                      operationStarted.resolve();
                      await releaseOperation.promise;
                    }
                    recorded.add(key);
                    if (operation === "rollback" && key === "second") {
                      options?.onDiskError?.(new Error("synthetic commit failure"));
                    }
                    return true;
                  },
                  release: () => undefined,
                })),
              });
            }
            hold.release("discard-pending");
            participant.settle({ kind: "completed" });
          } catch (error) {
            hold.release("replay-pending");
            participant.settle({ kind: "failed-retryable", error });
          }
        })();
        await settlement;
      });
      let stopped = false;
      const provider = monitorTelegramProvider({
        token: TELEGRAM_TOKEN,
        accountId: "test",
        config: {},
        useWebhook: true,
        webhookUrl: webhookUrl(getServerPort(gatewayServer), TELEGRAM_WEBHOOK_PATH),
        webhookPath: TELEGRAM_WEBHOOK_PATH,
        webhookSecret: TELEGRAM_SECRET,
        abortSignal: abort.signal,
        setStatus,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }).then(() => {
        stopped = true;
      });
      try {
        await waitForWebhookState(() => expect(setWebhookSpy).toHaveBeenCalledOnce());
        const url = requireMockCall(setWebhookSpy, 0, "setWebhook")[0];
        if (typeof url !== "string") {
          throw new Error("Expected the isolated Gateway webhook URL");
        }
        const response = await postWebhookJson({
          url,
          payload: JSON.stringify(telegramMessageUpdate(61, "held webhook work")),
          secret: TELEGRAM_SECRET,
        });
        expect(response.status).toBe(200);
        await operationStarted.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abort.abort();
        await vi.advanceTimersByTimeAsync(16_000);
        expect(stopped).toBe(false);
        expect(stopSpy).toHaveBeenCalledOnce();
        expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
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
      expect(
        (await listTelegramSpooledUpdates(requireWebhookQueueScope())).map(
          (entry) => entry.updateId,
        ),
      ).toEqual(operation === "rollback" ? [61] : []);
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
    },
  );

  it("retains the registered HTTP invocation until durable admission and acknowledgment", async () => {
    let releaseEnqueue: (() => void) | undefined;
    let markEnqueueStarted: (() => void) | undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const enqueueStarted = new Promise<void>((resolve) => {
      markEnqueueStarted = resolve;
    });
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
            enqueue: async (...args: Parameters<typeof queue.enqueue>) => {
              markEnqueueStarted?.();
              await enqueueGate;
              return await queue.enqueue(...args);
            },
          };
        },
      },
    } as TelegramRuntime);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        let responseSettled = false;
        const responseTask = postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(telegramMessageUpdate(4, "commit gate")),
          secret: TELEGRAM_SECRET,
        }).then((response) => {
          responseSettled = true;
          return response;
        });

        try {
          await enqueueStarted;
          await yieldWebhookTask();
          expect(responseSettled).toBe(false);
          expect(pendingRouteRequests.size).toBe(1);

          releaseEnqueue?.();
          const response = await responseTask;
          expect(response.status).toBe(200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(await response.text()).toBe("");
          expect(pendingRouteRequests.size).toBe(0);
        } finally {
          releaseEnqueue?.();
        }
      },
    );
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
    const payload = JSON.stringify(telegramMessageUpdate(3, "boom"));

    try {
      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
          runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        },
        async ({ port }) => {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload,
            secret: TELEGRAM_SECRET,
          });

          expect(response.status).toBe(200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(await response.text()).toBe("");
          await waitForWebhookState(() => expect(seenUpdates).toEqual([JSON.parse(payload)]));
          await waitForWebhookState(async () =>
            expect(await listTelegramSpooledUpdates(requireWebhookQueueScope())).toMatchObject([
              { updateId: 3, attempts: 1, lastError: "agent turn failed" },
            ]),
          );
          expectMockMessageContains(
            runtimeLog,
            "webhook spooled update 3 failed; keeping for retry",
          );
          vi.setSystemTime(Date.now() + 1_100);
          await vi.advanceTimersByTimeAsync(500);
          await waitForWebhookState(() =>
            expect(seenUpdates).toEqual([JSON.parse(payload), JSON.parse(payload)]),
          );
          await waitForWebhookState(async () =>
            expect(await listTelegramSpooledUpdates(requireWebhookQueueScope())).toEqual([]),
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: "environment override",
      envValue: "50",
      timeoutMs: 50,
    },
    {
      label: "canonical default",
      envValue: undefined,
      timeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
    },
  ])("uses the $label for webhook adoption stalls", async ({ envValue, timeoutMs }) => {
    vi.stubEnv("OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS", envValue);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let finishUpdate: (() => void) | undefined;
    const active: {
      dispatchStartedAt?: number;
      lifecycle?: NonNullable<ReturnType<typeof getTelegramSpooledReplayLifecycle>>;
    } = {};
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update: telegramMessageUpdate(39, "stalled"),
    });
    handleUpdateSpy.mockImplementationOnce(async () => {
      active.dispatchStartedAt = Date.now();
      active.lifecycle = getTelegramSpooledReplayLifecycle();
      await new Promise<void>((resolve) => {
        finishUpdate = resolve;
      });
    });

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
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
      finishUpdate?.();
      await started.stop();
    }
  });

  it("retries a timed-out webhook update before later same-lane updates", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      let finishFirstUpdate: (() => void) | undefined;
      let finishRetry: (() => void) | undefined;
      const seenUpdateIds: number[] = [];
      const firstUpdate = telegramMessageUpdate(40, "slow");
      const secondUpdate = telegramMessageUpdate(41, "blocked");
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: firstUpdate,
      });
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: secondUpdate,
      });
      handleUpdateSpy.mockImplementation(async (update: unknown) => {
        const updateId = (update as { update_id: number }).update_id;
        seenUpdateIds.push(updateId);
        if (updateId === 40) {
          await new Promise<void>((resolve) => {
            if (seenUpdateIds.filter((id) => id === 40).length === 1) {
              finishFirstUpdate = resolve;
            } else {
              finishRetry = resolve;
            }
          });
        }
      });

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        ...requireWebhookQueueScope(),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40]));
        await vi.advanceTimersByTimeAsync(DEFAULT_INGRESS_ADOPTION_STALL_MS + 10_000);
        await yieldWebhookTask();
        expect(seenUpdateIds).toEqual([40]);

        finishFirstUpdate?.();
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40]));
        finishRetry?.();
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 40, 41]));
      } finally {
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234:topic:42",
      canonicalLaneKey: "telegram:1234",
    },
    {
      topicsEnabled: true,
      persistedLaneKey: "telegram:1234",
      canonicalLaneKey: "telegram:1234:topic:42",
    },
  ])(
    "replays acknowledged legacy DM lanes after restart when topic capability is $topicsEnabled",
    async ({ topicsEnabled, persistedLaneKey, canonicalLaneKey }) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const firstUpdate = {
        update_id: 130,
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 1,
          message_thread_id: 42,
          text: "accepted before restart",
        },
      };
      const secondUpdate = {
        update_id: 131,
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 2,
          ...(topicsEnabled ? { message_thread_id: 42 } : {}),
          text: "accepted after the first event",
        },
      };
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: firstUpdate,
        laneKey: persistedLaneKey,
      });
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: secondUpdate,
        laneKey: canonicalLaneKey,
      });
      expect(
        (await openTelegramIngressQueue(requireWebhookQueueScope()).listPending()).map(
          (record) => record.laneKey,
        ),
      ).toEqual([persistedLaneKey, canonicalLaneKey]);
      closeOpenClawStateDatabaseForTest();

      const seenUpdateIds: number[] = [];
      let releaseFirstUpdate: (() => void) | undefined;
      const firstUpdateCompleted = new Promise<void>((resolve) => {
        releaseFirstUpdate = resolve;
      });
      handleUpdateSpy.mockImplementation(async (update: unknown) => {
        const updateId = (update as { update_id: number }).update_id;
        seenUpdateIds.push(updateId);
        if (updateId === firstUpdate.update_id) {
          await firstUpdateCompleted;
        }
      });

      try {
        await withStartedWebhook(
          {
            secret: TELEGRAM_SECRET,
            path: TELEGRAM_WEBHOOK_PATH,
          },
          async () => {
            await waitForWebhookState(() => expect(seenUpdateIds).toEqual([130]));
            await sleep(25);
            expect(seenUpdateIds).toEqual([130]);

            releaseFirstUpdate?.();
            await waitForWebhookState(() => expect(seenUpdateIds).toEqual([130, 131]));
            await waitForWebhookState(async () =>
              expect(await listTelegramSpooledUpdates(requireWebhookQueueScope())).toEqual([]),
            );
            expect(
              await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.(),
            ).toEqual([]);
            expect(handleUpdateSpy).toHaveBeenCalledTimes(2);
          },
        );
      } finally {
        releaseFirstUpdate?.();
      }
    },
  );

  it.each([
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234:topic:42",
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234:topic:42",
    },
    { approvalKind: "exec" as const, topicsEnabled: true, persistedLaneKey: "telegram:1234" },
    { approvalKind: "plugin" as const, topicsEnabled: true, persistedLaneKey: "telegram:1234" },
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234",
      hasThread: false,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234",
      hasThread: false,
    },
    {
      approvalKind: "exec" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:1234",
      hasThread: false,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:1234",
      hasThread: false,
    },
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:-1234",
      hasThread: false,
      chatId: -1234,
      chatType: "group" as const,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:-1234",
      hasThread: false,
      chatId: -1234,
      chatType: "group" as const,
    },
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:-1001234",
      hasThread: false,
      chatId: -1001234,
      chatType: "supergroup" as const,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:-1001234",
      hasThread: false,
      chatId: -1001234,
      chatType: "supergroup" as const,
    },
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:-1001234:topic:42",
      chatId: -1001234,
      chatType: "supergroup" as const,
      isForum: true,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:-1001234:topic:42",
      chatId: -1001234,
      chatType: "supergroup" as const,
      isForum: true,
    },
    {
      approvalKind: "exec" as const,
      topicsEnabled: false,
      persistedLaneKey: "telegram:-1001234:topic:1",
      hasThread: false,
      chatId: -1001234,
      chatType: "supergroup" as const,
      isForum: true,
    },
    {
      approvalKind: "plugin" as const,
      topicsEnabled: true,
      persistedLaneKey: "telegram:-1001234:topic:1",
      hasThread: false,
      chatId: -1001234,
      chatType: "supergroup" as const,
      isForum: true,
    },
  ])(
    "replays acknowledged typed $approvalKind approvals in their privileged lane (chat=$chatType, topics=$topicsEnabled, thread=$hasThread)",
    async ({
      approvalKind,
      topicsEnabled,
      persistedLaneKey,
      hasThread,
      chatId,
      chatType,
      isForum,
    }) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const callback = createTelegramPrivateTopicCallback(142, webhookBotInfo.id);
      const expectedChatId = chatId ?? callback.message.chat.id;
      const update = {
        update_id: 142,
        callback_query: {
          ...callback,
          message: {
            ...callback.message,
            chat: {
              ...callback.message.chat,
              id: expectedChatId,
              type: chatType ?? callback.message.chat.type,
              ...(isForum ? { is_forum: true } : {}),
            },
            ...(hasThread === false ? { message_thread_id: undefined } : {}),
          },
          data: buildTelegramApprovalCallbackData({
            type: "approval",
            approvalKind,
            approvalId: "signed-approval",
            decision: "allow-once",
          }),
        },
      };
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update,
        laneKey: persistedLaneKey,
      });
      closeOpenClawStateDatabaseForTest();

      handleUpdateSpy.mockImplementationOnce(async () => {
        expect(
          await openTelegramIngressQueue(requireWebhookQueueScope()).listClaims(),
        ).toMatchObject([{ laneKey: `telegram:${expectedChatId}:approval` }]);
      });

      await withStartedWebhook(
        { secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH },
        async () => {
          await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledOnce());
          expect(handleUpdateSpy).toHaveBeenCalledWith(update);
          await waitForWebhookState(async () =>
            expect(
              await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.(),
            ).toEqual([]),
          );
        },
      );
    },
  );

  it.each([
    {
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234:topic:42",
    },
    {
      topicsEnabled: true,
      persistedLaneKey: "telegram:1234",
    },
    {
      topicsEnabled: false,
      persistedLaneKey: "telegram:1234:topic:42",
      callbackIdentityLength: 128,
    },
  ])(
    "replays legitimate private callbacks after a topic-capability transition ($topicsEnabled)",
    async ({ topicsEnabled, persistedLaneKey, callbackIdentityLength }) => {
      webhookBotInfo.has_topics_enabled = topicsEnabled;
      const update = {
        update_id: 140,
        callback_query: {
          ...createTelegramPrivateTopicCallback(140, webhookBotInfo.id),
          ...(callbackIdentityLength
            ? {
                id: "i".repeat(callbackIdentityLength),
                chat_instance: "c".repeat(callbackIdentityLength),
              }
            : {}),
        },
      };
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update,
        laneKey: persistedLaneKey,
      });
      closeOpenClawStateDatabaseForTest();

      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
        },
        async () => {
          await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledOnce());
          expect(handleUpdateSpy).toHaveBeenCalledWith(update);
          expect(await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.()).toEqual(
            [],
          );
        },
      );
    },
  );

  it.each([
    {
      name: "a bot callback sender",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        from: { ...callback.from, is_bot: true },
      }),
    },
    {
      name: "an invalid callback sender",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        from: { ...callback.from, id: 0 },
      }),
    },
    {
      name: "a foreign bot-authored message",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: {
          ...callback.message,
          from: { ...callback.message.from, id: 999 },
        },
      }),
    },
    {
      name: "an inaccessible callback message",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, date: 0 },
      }),
    },
    {
      name: "an independent business chat",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, business_connection_id: "business-1234" },
      }),
    },
    {
      name: "an independent guest chat",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, guest_query_id: "guest-1234" },
      }),
    },
    {
      name: "a message sent by another chat",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, sender_chat: { id: -1234, type: "channel" } },
      }),
    },
    {
      name: "a direct-messages topic from another surface",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, direct_messages_topic: { topic_id: 42 } },
      }),
    },
    {
      name: "an inline callback message",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        inline_message_id: "inline-message-141",
      }),
    },
    {
      name: "an oversized callback payload",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: "x".repeat(65),
      }),
    },
    {
      name: "a missing chat instance",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        chat_instance: "",
      }),
    },
    {
      name: "a reserved question callback",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
      }),
    },
    {
      name: "a reserved approval callback",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: "/approve exec:def456 deny",
      }),
    },
    {
      name: "a malformed signed approval decision",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        })?.replace(":o:", ":z:"),
      }),
    },
    {
      name: "a malformed signed approval without a topic",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        })?.replace(":o:", ":z:"),
        message: { ...callback.message, message_thread_id: undefined },
      }),
    },
    {
      name: "a malformed signed approval kind",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        })?.replace(":e:", ":x:"),
      }),
    },
    {
      name: "a signed approval missing its canonical identifier",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "plugin",
          approvalId: "signed-approval",
          decision: "deny",
        })?.replace(/signed-approval$/, ""),
      }),
    },
    {
      name: "a signed approval in another business namespace",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        }),
        message: { ...callback.message, business_connection_id: "business-1234" },
      }),
    },
    {
      name: "a signed approval in another guest namespace",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "plugin",
          approvalId: "signed-approval",
          decision: "deny",
        }),
        message: { ...callback.message, guest_query_id: "guest-1234" },
      }),
    },
    {
      name: "a signed approval from a foreign bot",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        }),
        message: { ...callback.message, from: { ...callback.message.from, id: 999 } },
      }),
    },
    {
      name: "a signed approval from an invalid actor",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "plugin",
          approvalId: "signed-approval",
          decision: "deny",
        }),
        from: { ...callback.from, id: 0 },
      }),
    },
    {
      name: "a signed approval for another chat",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        }),
        message: { ...callback.message, chat: { ...callback.message.chat, id: 9999 } },
      }),
    },
    {
      name: "an inline signed approval",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: buildTelegramApprovalCallbackData({
          type: "approval",
          approvalKind: "exec",
          approvalId: "signed-approval",
          decision: "allow-once",
        }),
        inline_message_id: "inline-message-141",
      }),
    },
    {
      name: "a malformed reserved question callback",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:9",
      }),
    },
    {
      name: "a reserved question callback without a topic",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
        message: { ...callback.message, message_thread_id: undefined },
      }),
    },
    {
      name: "an ordinary callback without a topic",
      mutate: (callback: ReturnType<typeof createTelegramPrivateTopicCallback>) => ({
        ...callback,
        message: { ...callback.message, message_thread_id: undefined },
      }),
    },
  ])("does not authorize durable-lane reconciliation for $name", async ({ mutate }) => {
    const laneKey = "telegram:1234:topic:42";
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update: {
        update_id: 141,
        callback_query: mutate(createTelegramPrivateTopicCallback(141, webhookBotInfo.id)),
      },
      laneKey,
    });
    closeOpenClawStateDatabaseForTest();

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async () => {
        await waitForWebhookState(async () =>
          expect(
            await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.({
              limit: "all",
            }),
          ).toMatchObject([{ reason: "invalid-event", laneKey }]),
        );
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["telegram:9999:topic:42", "telegram:1234:topic:99", "telegram:1234:control"])(
    "rejects persisted DM lanes outside the signed upgrade contract (%s)",
    async (laneKey) => {
      await writeTelegramSpooledUpdate({
        ...requireWebhookQueueScope(),
        update: {
          update_id: 132,
          message: {
            chat: { id: 1234, type: "private" },
            message_id: 1,
            message_thread_id: 42,
            text: "reject mismatched durable identity",
          },
        },
        laneKey,
      });
      closeOpenClawStateDatabaseForTest();

      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
        },
        async () => {
          await waitForWebhookState(async () =>
            expect(
              await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.({
                limit: "all",
              }),
            ).toMatchObject([{ reason: "invalid-event", laneKey }]),
          );
          expect(handleUpdateSpy).not.toHaveBeenCalled();
          expect(await listTelegramSpooledUpdates(requireWebhookQueueScope())).toEqual([]);
        },
      );
    },
  );

  it("leaves another account's pending ingress untouched", async () => {
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update: telegramMessageUpdate(133, "other account pending"),
    });
    const ownUpdate = telegramMessageUpdate(134, "this account receives");
    const delivered = createDeferred<void>();
    handleUpdateSpy.mockImplementationOnce(() => delivered.resolve());

    await withStartedWebhook(
      { accountId: "other", secret: TELEGRAM_SECRET, path: TELEGRAM_WEBHOOK_PATH },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(ownUpdate),
          secret: TELEGRAM_SECRET,
        });
        expect(response.status).toBe(200);
        await delivered.promise;
        expect(handleUpdateSpy).toHaveBeenCalledWith(ownUpdate);
        expect(handleUpdateSpy).toHaveBeenCalledOnce();
        expect(await listTelegramSpooledUpdates(requireWebhookQueueScope())).toMatchObject([
          { updateId: 133 },
        ]);
        expect(await openTelegramIngressQueue(requireWebhookQueueScope()).listClaims()).toEqual([]);
      },
    );
  });

  it.each([
    {
      name: "a malformed callback query",
      update: {
        update_id: 134,
        callback_query: {
          data: "unrecognized-callback",
          message: {
            chat: { id: 1234, type: "private" },
            message_id: 1,
            message_thread_id: 42,
          },
        },
      },
    },
    {
      name: "a group message",
      update: {
        update_id: 135,
        message: {
          chat: { id: 1234, type: "group" },
          message_id: 1,
          message_thread_id: 42,
          text: "wrong chat kind",
        },
      },
    },
  ])("rejects legacy lane reconciliation for $name", async ({ update }) => {
    const laneKey = "telegram:1234:topic:42";
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update,
      laneKey,
    });
    closeOpenClawStateDatabaseForTest();

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async () => {
        await waitForWebhookState(async () =>
          expect(
            await openTelegramIngressQueue(requireWebhookQueueScope()).listFailed?.({
              limit: "all",
            }),
          ).toMatchObject([{ reason: "invalid-event", laneKey }]),
        );
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
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
    await writeTelegramSpooledUpdate({
      ...requireWebhookQueueScope(),
      update: telegramMessageUpdate(52, "stop retry"),
    });
    const retryScheduled = createDeferred<void>();
    const runtimeLog = vi.fn((message: unknown) => {
      if (
        typeof message === "string" &&
        /completion retry 1 scheduled|tombstone retry 1\//.test(message)
      ) {
        retryScheduled.resolve();
      }
    });
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });

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
    handleUpdateSpy.mockClear();
    answerCallbackQuerySpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({
            callback_query: createTelegramPrivateTopicCallback(33, webhookBotInfo.id),
          }),
          secret: TELEGRAM_SECRET,
        });

        expect(response.status).toBe(500);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        expect(answerCallbackQuerySpy).not.toHaveBeenCalled();
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects unauthenticated requests before reading the request body", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const response = await postWebhookHeadersOnly({
          port,
          path: TELEGRAM_WEBHOOK_PATH,
          declaredLength: 1_024 * 1_024,
          secret: "wrong-secret",
        });

        expect(response.statusCode).toBe(401);
        expect(response.body).toBe("unauthorized");
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("rate limits repeated invalid secret guesses without throttling authenticated delivery", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        let saw429 = false;

        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify({ update_id: i, message: { text: `guess ${i}` } }),
            secret: `wrong-secret-${String(i).padStart(3, "0")}`,
          });

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

        const validResponse = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify(telegramMessageUpdate(999, "hello")),
          secret: TELEGRAM_SECRET,
        });
        expect(validResponse.status).toBe(200);
        expect(validResponse.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(await validResponse.text()).toBe("");
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
      },
    );
  });

  it("does not rate limit authenticated webhook request storms", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify(telegramMessageUpdate(10_000 + i, `valid ${i}`)),
            secret: TELEGRAM_SECRET,
          });
          expect(response.status).toBe(200);
        }
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalled());
      },
    );
  });

  it.each([
    {
      name: "untrusted loopback hops",
      trustedProxy: "127.0.0.1",
      suffix: ", 127.0.0.2",
      otherHopStatus: 401,
    },
    {
      name: "ignored bracketed proxy entries",
      trustedProxy: "[127.0.0.1]",
      suffix: "",
      otherHopStatus: 429,
    },
  ])(
    "isolates legacy auth budgets and preserves $name across account restarts",
    async ({ trustedProxy, suffix, otherHopStatus }) => {
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
        const body = await response.text();
        return {
          status: response.status,
          body,
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
        expect(await request(`203.0.113.1${suffix}`)).toEqual({
          status: 429,
          body: "Too Many Requests",
          accepted: null,
        });
        shared = await startTelegramWebhook({
          ...base,
          accountId: "shared",
          secret: "shared-secret",
          legacyWebhook: endpoint,
        });
        expect(await request(`203.0.113.1${suffix}`)).toEqual({
          status: 429,
          body: "Too Many Requests",
          accepted: null,
        });
        expect((await request("203.0.113.1, 127.0.0.3")).status).toBe(otherHopStatus);
        expect(await request(`203.0.113.1${suffix}`, "shared-secret")).toEqual({
          status: 200,
          body: "",
          accepted: "durable",
        });
        expect(await request(`203.0.113.1${suffix}`, TELEGRAM_SECRET)).toEqual({
          status: 200,
          body: "",
          accepted: "durable",
        });

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
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });

  it.each([
    { path: "/hook?token=known", legacyWebhook: false as const },
    { path: "/ready/webhook", legacyWebhook: false as const },
    { path: "/readyz?token=known", legacyWebhook: undefined },
    { path: "/healthz?token=known", legacyWebhook: undefined },
    { path: "/%61pi/channels/telegram", legacyWebhook: { port: 8787, host: "127.0.0.1" } },
  ])("preserves exact webhook target $path", async ({ path, legacyWebhook }) => {
    await withStartedWebhook({ secret: TELEGRAM_SECRET, path, legacyWebhook }, async ({ port }) => {
      legacyListenerForRequest.mockReturnValue(
        legacyWebhook === false ? undefined : (legacyWebhook ?? { port: 8787, host: "127.0.0.1" }),
      );
      const accepted = await postWebhookJson({
        url: webhookUrl(port, path),
        payload: JSON.stringify(telegramMessageUpdate(807, "exact route")),
        secret: TELEGRAM_SECRET,
      });
      expect(accepted.status).toBe(200);
      const rejected = await postWebhookJson({
        url: webhookUrl(port, `${path}${path.includes("?") ? "&" : "?"}changed=true`),
        payload: JSON.stringify(telegramMessageUpdate(808, "wrong route")),
        secret: TELEGRAM_SECRET,
      });
      expect(rejected.status).toBe(404);
    });
  });

  it.each(telegramWebhookListenerCases)(
    "registers the public URL with $name legacy listener",
    async ({ legacyWebhook, endpoint }) => {
      const runtimeLog = vi.fn();
      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
          legacyWebhook,
          runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        },
        async ({ port }) => {
          expect(gateway.registry.httpRoutes[0]?.legacyListeners).toEqual(
            endpoint ? [{ ...endpoint, health: { path: "/healthz" } }] : undefined,
          );
          expect(port).toBeGreaterThan(0);
          expect(setWebhookSpy).toHaveBeenCalledTimes(1);
          const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
          expect(setWebhookCall[0]).toBe(webhookUrl(port, TELEGRAM_WEBHOOK_PATH));
          expect(requireRecord(setWebhookCall[1], "setWebhook options").secret_token).toBe(
            TELEGRAM_SECRET,
          );
          expect(runtimeLog).toHaveBeenCalledWith(
            `telegram webhook Gateway route ${TELEGRAM_WEBHOOK_PATH} (port 18789)`,
          );
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
      const seenUpdateIds: number[] = [];
      let releaseFirstUpdate: (() => void) | undefined;
      const firstUpdateCompleted = new Promise<void>((resolve) => {
        releaseFirstUpdate = resolve;
      });
      handleUpdateSpy.mockImplementation(async (update: unknown) => {
        const updateId = (update as { update_id: number }).update_id;
        seenUpdateIds.push(updateId);
        if (updateId === 100) {
          await firstUpdateCompleted;
        }
      });

      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
        },
        async ({ port }) => {
          const url = webhookUrl(port, TELEGRAM_WEBHOOK_PATH);
          const firstUpdate = {
            update_id: 100,
            message: {
              chat: { id: 1234, type: "private" },
              message_id: 1,
              text: "first",
            },
          };
          const secondUpdate = {
            update_id: 101,
            message: {
              chat: { id: 1234, type: "private" },
              message_id: 2,
              message_thread_id: 42,
              text: "second",
            },
          };

          try {
            const firstResponse = await postWebhookJson({
              url,
              payload: JSON.stringify(firstUpdate),
              secret: TELEGRAM_SECRET,
            });
            expect(firstResponse.status).toBe(200);
            await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100]));

            const secondResponse = await postWebhookJson({
              url,
              payload: JSON.stringify(secondUpdate),
              secret: TELEGRAM_SECRET,
            });
            expect(secondResponse.status).toBe(200);

            if (shouldSerialize) {
              await sleep(25);
              expect(seenUpdateIds).toEqual([100]);
            } else {
              await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100, 101]));
            }
          } finally {
            releaseFirstUpdate?.();
          }

          await waitForWebhookState(() => expect(seenUpdateIds).toEqual([100, 101]));
        },
      );
    },
  );

  it("handles near-limit payload with random chunk writes and event-loop yields", async () => {
    await runNearLimitPayloadTestAndExpectUpdate("random-chunked");
  });

  it("handles near-limit payload written in a single request write", async () => {
    await runNearLimitPayloadTestAndExpectUpdate("single");
  });

  it("rejects payloads larger than 1MB before invoking webhook handler", async () => {
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
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
      },
    );
  });

  it("does not de-register webhook when shutting down", async () => {
    deleteWebhookSpy.mockClear();
    const abort = new AbortController();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      abortSignal: abort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
    });

    await started.stop();
    abort.abort();
    expect(deleteWebhookSpy).toHaveBeenCalledTimes(0);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
