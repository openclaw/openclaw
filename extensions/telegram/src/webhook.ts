import type { IncomingMessage, ServerResponse } from "node:http";
import { InputFile } from "grammy";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDiagnosticsEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  resolveGatewayPort,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
} from "openclaw/plugin-sdk/logging-core";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { BackoffPolicy, RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  computeBackoff,
  defaultRuntime,
  formatDurationPrecise,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { extractErrorCode, safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  getWebhookLegacyListener,
  normalizeWebhookPath,
  registerPluginHttpRoute,
  registerWebhookTarget,
  resolveRequestClientIp,
  resolveSingleWebhookTarget,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  readJsonBodyWithLimit,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import {
  mergeTelegramAccountConfig,
  resolveTelegramLegacyWebhookListener,
} from "./account-config.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isRetryableTelegramApiError, isTelegramAuthenticationError } from "./network-errors.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { createTelegramStatusPublisher } from "./transport-status.js";
import { createTelegramLegacyWebhookAuthLimiter } from "./webhook-legacy.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const TELEGRAM_WEBHOOK_TEXT_TYPE = "text/plain; charset=utf-8";
const TELEGRAM_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const TELEGRAM_WEBHOOK_ACCEPTED_VALUE = "durable";
const TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS = 500;
const TELEGRAM_WEBHOOK_INGRESS_STOP_GRACE_MS = 15_000;
const TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};
function formatWebhookStartupError(error: unknown): string {
  const message = formatErrorMessage(error);
  const code = extractErrorCode(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

async function waitForWebhookIngressStop(task: Promise<void> | undefined): Promise<void> {
  if (!task) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TELEGRAM_WEBHOOK_INGRESS_STOP_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function initializeTelegramWebhookBot(params: {
  abortSignal?: AbortSignal;
  bot: Awaited<ReturnType<typeof createTelegramBot>>;
  onRetry: () => void;
  retryPolicy: BackoffPolicy;
  runtime: RuntimeEnv;
}) {
  let attempt = 0;
  while (true) {
    try {
      await withTelegramApiErrorLogging({
        operation: "getMe",
        runtime: params.runtime,
        fn: () => params.bot.init(params.abortSignal as Parameters<(typeof params.bot)["init"]>[0]),
      });
      return;
    } catch (err) {
      if (
        !isRetryableTelegramApiError(err, { context: "webhook" }) ||
        params.abortSignal?.aborted
      ) {
        throw err;
      }
      attempt += 1;
      params.onRetry();
      const delayMs = computeBackoff(params.retryPolicy, attempt);
      params.runtime.log?.(
        `telegram getMe retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}`,
      );
      await sleepWithAbort(delayMs, params.abortSignal);
    }
  }
}

function resolveSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  if (typeof header === "string") {
    return header;
  }
  if (Array.isArray(header) && header.length === 1) {
    return header[0];
  }
  return undefined;
}

type TelegramWebhookTarget = {
  path: string;
  requestPath: string;
  secret: string;
  legacyListener?: { port: number; host?: string };
  legacyAuthGuard?: ReturnType<typeof createTelegramLegacyWebhookAuthLimiter>;
  diagnosticsEnabled: () => boolean;
  isActive: () => boolean;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

const webhookState = createPluginRuntimeStore<{
  targets: Map<string, TelegramWebhookTarget[]>;
  rateLimiter: ReturnType<typeof createFixedWindowRateLimiter>;
}>("Telegram webhook routes are not registered");

async function handleTelegramWebhook(
  webhookTargets: Map<string, TelegramWebhookTarget[]>,
  rateLimiter: ReturnType<typeof createFixedWindowRateLimiter>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const legacyListener = getWebhookLegacyListener(req);
  const targets = webhookTargets
    .get(normalizeWebhookPath(req.url ?? ""))
    ?.filter(
      (target) =>
        target.isActive() &&
        target.requestPath === req.url &&
        (!legacyListener ||
          (target.legacyListener?.port === legacyListener.port &&
            target.legacyListener?.host === legacyListener.host)),
    );
  if (!targets?.length || req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (targets.some((target) => target.diagnosticsEnabled())) {
    logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
  }
  const secret = resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]);
  const match = resolveSingleWebhookTarget(targets, (target) =>
    safeEqualSecret(secret, target.secret),
  );
  if (match.kind !== "single") {
    // Authenticated Telegram delivery must not consume the abuse budget. Only
    // failed secret guesses are rate-limited, before the body is read.
    // An invalid secret cannot identify an account. Shared legacy endpoints use
    // their first live target's failure budget and shipped proxy-hop policy.
    const legacyAuthGuard = legacyListener ? targets[0]?.legacyAuthGuard : undefined;
    const allowed = legacyAuthGuard
      ? legacyAuthGuard(req, res)
      : applyBasicWebhookRequestGuards({
          req,
          res,
          rateLimiter,
          rateLimitKey: `${req.url}:${resolveRequestClientIp(req) ?? "unknown"}`,
        });
    if (!allowed) {
      return true;
    }
    res.shouldKeepAlive = false;
    res.writeHead(401, { Connection: "close", "Content-Type": TELEGRAM_WEBHOOK_TEXT_TYPE });
    res.end(match.kind === "ambiguous" ? "ambiguous webhook target" : "unauthorized");
    return true;
  }
  await match.target.handle(req, res);
  return true;
}

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  ownerAgentId?: string;
  config?: OpenClawConfig;
  path?: string;
  legacyWebhook?: false | { port: number; host?: string };
  secret?: string;
  runtime?: RuntimeEnv;
  buildContext?: Parameters<typeof createTelegramBot>[0]["buildContext"];
  dispatchReplyFromConfig?: Parameters<typeof createTelegramBot>[0]["dispatchReplyFromConfig"];
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  publicUrl?: string;
  webhookCertPath?: string;
  webhookRegistrationRetryPolicy?: BackoffPolicy;
  stateDir?: string;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  let state = webhookState.tryGetRuntime();
  if (!state) {
    state = {
      targets: new Map(),
      rateLimiter: createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS),
    };
    webhookState.setRuntime(state);
  }
  const { targets: webhookTargets, rateLimiter } = state;
  const readConfig = createRuntimeConfigReader(opts.config ?? {});
  const legacyListener = resolveTelegramLegacyWebhookListener(opts.legacyWebhook);
  const path = opts.path ?? "/telegram-webhook";
  if (path === "/healthz") {
    throw new Error(`Telegram webhook path "${path}" conflicts with the health path.`);
  }
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  const pathConflict =
    probe === "live" || probe === "ready" || probe === "startup"
      ? "is reserved for Gateway probes"
      : isProtectedPluginRoutePathFromContext(resolvePluginRoutePathContext(pathname))
        ? "requires Gateway authentication"
        : undefined;
  if (pathConflict && !legacyListener) {
    throw new Error(
      `Telegram webhook path "${path}" ${pathConflict}. Set webhookPath to /telegram-webhook and update webhookUrl or its reverse-proxy mapping before restarting.`,
    );
  }
  const secret = normalizeOptionalString(opts.secret) ?? "";
  if (!secret) {
    throw new Error(
      "Telegram webhook mode requires a non-empty secret token. " +
        "Set channels.telegram.webhookSecret in your config.",
    );
  }
  const publicUrl = normalizeOptionalString(opts.publicUrl);
  if (!publicUrl) {
    throw new Error(
      "Telegram webhook mode requires webhookUrl pointing to the Gateway webhook route.",
    );
  }
  const runtime = opts.runtime ?? defaultRuntime;
  if (pathConflict) {
    runtime.log?.(
      `Telegram webhook path "${path}" ${pathConflict} on the Gateway port; its legacy listener remains available. Set webhookPath to /telegram-webhook and update webhookUrl or its reverse-proxy mapping before setting legacyWebhook: false.`,
    );
  }
  const status = createTelegramStatusPublisher("webhook", opts.setStatus);
  status.noteStart();
  const webhookRegistrationRetryPolicy =
    opts.webhookRegistrationRetryPolicy ?? TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY;
  let shutDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let unregisterRoute: (() => void) | undefined;
  let unregisterTarget: (() => void) | undefined;
  let webhookIngressMonitor: ReturnType<typeof createTelegramTransportIngressMonitor> | undefined;
  const shutdownAbortController = new AbortController();
  const telegramAccountConfig = opts.config
    ? mergeTelegramAccountConfig(opts.config, opts.accountId ?? "default")
    : undefined;
  const telegramTransport = resolveTelegramTransport(opts.fetch, {
    network: telegramAccountConfig?.network,
  });
  let closeTransportPromise: Promise<void> | undefined;
  const closeTransportOnce = (): Promise<void> => {
    closeTransportPromise ??= telegramTransport.close();
    return closeTransportPromise;
  };
  const botAbortController = new AbortController();
  const accountAbortSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, shutdownAbortController.signal])
    : shutdownAbortController.signal;
  const botFetchAbortSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, botAbortController.signal])
    : botAbortController.signal;
  const bot = await createTelegramBot({
    token: opts.token,
    runtime,
    buildContext: opts.buildContext,
    dispatchReplyFromConfig: opts.dispatchReplyFromConfig,
    proxyFetch: opts.fetch,
    fetchAbortSignal: botFetchAbortSignal,
    accountAbortSignal,
    config: opts.config,
    accountId: opts.accountId,
    ownerAgentId: opts.ownerAgentId,
    telegramTransport,
  });
  const runShutdownPhase = async (
    label: string,
    run: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (err) {
      runtime.error?.(`telegram webhook ${label} failed: ${formatErrorMessage(err)}`);
    }
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutDown = true;
    const ingressMonitor = webhookIngressMonitor;
    webhookIngressMonitor = undefined;
    shutdownPromise = Promise.resolve().then(async () => {
      // Every fallible phase is isolated so one failed release cannot skip the
      // remaining resources or reject the fire-and-forget abort hook.
      const ingressStopTask = ingressMonitor
        ? runShutdownPhase("ingress stop", () => ingressMonitor.stop())
        : undefined;
      await runShutdownPhase("route release", () => {
        unregisterRoute?.();
        unregisterTarget?.();
      });
      await runShutdownPhase("bot stop", () => bot.stop());
      // The webhook owns this transport because it resolved and injected it into
      // createTelegramBot; close once so abort/startup-failure paths cannot leak sockets.
      await runShutdownPhase("transport close", closeTransportOnce);
      await runShutdownPhase("ingress drain", () => waitForWebhookIngressStop(ingressStopTask));
      await runShutdownPhase("ingress settlement", () => ingressMonitor?.waitForDeferredClaims());
      await runShutdownPhase("status update", () => status.noteStop());
    });
    // Publish the cleanup promise before abort listeners can reenter stop().
    botAbortController.abort();
    shutdownAbortController.abort();
    return shutdownPromise;
  };
  const runStartupPhase = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (!opts.abortSignal?.aborted) {
        status.noteError(
          formatWebhookStartupError(err),
          isTelegramAuthenticationError(err) ? "blocked" : undefined,
        );
      }
      await shutdown();
      throw err;
    }
  };
  await runStartupPhase(() =>
    initializeTelegramWebhookBot({
      bot,
      runtime,
      abortSignal: opts.abortSignal,
      onRetry: () => status.noteRecovery(),
      retryPolicy: webhookRegistrationRetryPolicy,
    }),
  );
  const botInfo = bot.botInfo;
  const log = (line: string) => runtime.log?.(line);
  const startWebhookSpoolDrain = () => {
    if (webhookIngressMonitor) {
      return;
    }
    // Shutdown must abort in-flight drain work (tombstone retries), not just
    // stop the next claim; the composed signal carries webhook stop + caller abort.
    webhookIngressMonitor = createTelegramTransportIngressMonitor({
      stateDir: opts.stateDir,
      bot,
      botInfo,
      accountId: opts.accountId ?? "default",
      pollIntervalMs: TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS,
      abortSignal: accountAbortSignal,
      onLog: (message) => log(`webhook ${message}`),
      onError: (error) =>
        log(`[telegram][diag] webhook spool drain failed: ${formatErrorMessage(error)}`),
    });
    webhookIngressMonitor.start();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const respondText = (statusCode: number, text = "") => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      res.writeHead(statusCode, { "Content-Type": TELEGRAM_WEBHOOK_TEXT_TYPE });
      res.end(text);
    };

    const startTime = Date.now();
    try {
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
        emptyObjectOnEmpty: false,
        // Defer destruction so the rejections below reach Telegram before the close.
        destroyOnLimit: false,
      });
      if (!body.ok) {
        if (body.code === "PAYLOAD_TOO_LARGE") {
          await sendHttpRequestRejection(req, res, 413, body.error, TELEGRAM_WEBHOOK_TEXT_TYPE);
          return;
        }
        if (body.code === "REQUEST_BODY_TIMEOUT") {
          await sendHttpRequestRejection(req, res, 408, body.error, TELEGRAM_WEBHOOK_TEXT_TYPE);
          return;
        }
        respondText(400, body.error);
        return;
      }

      // Telegram sees 200 only after the update is durable. If SQLite rejects
      // the enqueue, this path returns non-200 so Telegram redelivers.
      const ingressMonitor = webhookIngressMonitor;
      if (!ingressMonitor) {
        throw new Error("Telegram webhook ingress is not ready.");
      }
      await ingressMonitor.admit(body.value);
      // Enqueue duplicate detection makes Telegram webhook retries idempotent:
      // re-posted update_ids map to the same spool row and still ack fast.
      res.setHeader(TELEGRAM_WEBHOOK_ACCEPTED_HEADER, TELEGRAM_WEBHOOK_ACCEPTED_VALUE);
      respondText(200);
      status.noteReady();
      if (isDiagnosticsEnabled(readConfig())) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    } catch (err) {
      const errMsg = formatErrorMessage(err);
      if (isDiagnosticsEnabled(readConfig())) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook request failed: ${errMsg}`);
      respondText(500);
    }
  };
  await runStartupPhase(() => {
    const registered = registerWebhookTarget(
      webhookTargets,
      {
        path,
        requestPath: path,
        secret,
        legacyListener,
        legacyAuthGuard: legacyListener
          ? createTelegramLegacyWebhookAuthLimiter(opts.config)
          : undefined,
        handle,
        diagnosticsEnabled: () => isDiagnosticsEnabled(readConfig()),
        isActive: () => !shutDown && !opts.abortSignal?.aborted,
      },
      {
        onLastPathTargetRemoved: () => {
          if (webhookTargets.size === 0) {
            rateLimiter.clear();
          }
        },
      },
    );
    unregisterTarget = registered.unregister;
    unregisterRoute = registerPluginHttpRoute({
      path,
      auth: "plugin",
      pluginId: "telegram",
      source: "webhook",
      accountId: opts.accountId,
      reuseExistingSameOwner: true,
      throwOnFailure: true,
      legacyListener: legacyListener
        ? { ...legacyListener, health: { path: "/healthz" } }
        : undefined,
      handler: (req, res) => handleTelegramWebhook(webhookTargets, rateLimiter, req, res),
      log,
    });
  });

  let webhookAdvertised = false;
  if (opts.abortSignal?.aborted) {
    void shutdown();
  } else if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => void shutdown(), { once: true });
  }

  const advertiseWebhook = async (): Promise<void> => {
    if (shutDown || opts.abortSignal?.aborted) {
      return;
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "setWebhook",
        runtime,
        fn: () =>
          bot.api.setWebhook(publicUrl, {
            secret_token: secret,
            allowed_updates: resolveTelegramAllowedUpdates(),
            certificate: opts.webhookCertPath ? new InputFile(opts.webhookCertPath) : undefined,
          }),
      });
    } catch (err) {
      status.noteError(
        formatErrorMessage(err),
        isTelegramAuthenticationError(err)
          ? "blocked"
          : isRetryableTelegramApiError(err, { context: "webhook" })
            ? "recovering"
            : undefined,
      );
      throw err;
    }
    if (shutDown) {
      return;
    }
    webhookAdvertised = true;
    status.noteReady();
    runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);
  };
  const retryWebhookRegistration = async (firstAttempt: number): Promise<void> => {
    let attempt = firstAttempt;
    while (true) {
      if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) {
        return;
      }
      const delayMs = computeBackoff(webhookRegistrationRetryPolicy, attempt);
      runtime.log?.(
        `telegram setWebhook retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}`,
      );
      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch {
        return;
      }
      if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) {
        return;
      }
      try {
        await advertiseWebhook();
        return;
      } catch (err) {
        if (!isRetryableTelegramApiError(err, { context: "webhook" })) {
          runtime.error?.(
            `telegram setWebhook retry stopped after non-recoverable error: ${formatErrorMessage(err)}`,
          );
          await shutdown();
          return;
        }
      }
      attempt += 1;
    }
  };

  if (
    (webhookTargets.get(normalizeWebhookPath(path)) ?? []).filter(
      (target) => target.requestPath === path && safeEqualSecret(target.secret, secret),
    ).length > 1
  ) {
    runtime.error?.(
      `Telegram accounts on Gateway route ${path} share a webhook secret. Give each account a distinct webhookSecret or webhookPath. Separate legacy endpoints retain account routing while you update the Gateway routes.`,
    );
  }
  const gatewayPort = resolveGatewayPort(opts.config);
  runtime.log?.(`telegram webhook Gateway route ${path} (port ${gatewayPort})`);
  runtime.log?.(
    legacyListener
      ? `Telegram legacy webhook listener ${legacyListener.host}:${legacyListener.port} forwards to the Gateway route. Point the reverse proxy for ${publicUrl} at Gateway port ${gatewayPort}${path}, verify delivery, then set legacyWebhook: false to disable legacy forwarding for this account.`
      : `Telegram legacy forwarding for this account is disabled by legacyWebhook: false. Route ${publicUrl} to Gateway port ${gatewayPort}${path}.`,
  );

  if (!shutDown) {
    try {
      await advertiseWebhook();
    } catch (err) {
      if (!isRetryableTelegramApiError(err, { context: "webhook" })) {
        await shutdown();
        throw err;
      }
      void retryWebhookRegistration(1);
    }
  }
  // Drain only after registration succeeds or after the retrying startup path
  // is ready to return a stop handle; failed startup must not claim durable work.
  if (!shutDown) {
    await runStartupPhase(startWebhookSpoolDrain);
  }

  return { bot, stop: shutdown };
}
