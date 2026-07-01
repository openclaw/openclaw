// Telegram plugin module implements webhook behavior.
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { InputFile } from "grammy";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDiagnosticsEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "openclaw/plugin-sdk/logging-core";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { BackoffPolicy, RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  computeBackoff,
  defaultRuntime,
  formatDurationPrecise,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { createTelegramBot } from "./bot.js";
import { isRetryableTelegramApiError } from "./network-errors.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import {
  resolveNonRetryableSpooledUpdateFailure,
  resolveSpooledUpdateAttemptNumber,
  resolveSpooledUpdateRetryDelayMs,
  shouldDeadLetterRetryableSpooledUpdate,
  TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS,
} from "./spooled-update-retry-policy.js";
import {
  claimNextTelegramSpooledUpdate,
  completeTelegramSpooledUpdate,
  failTelegramSpooledUpdateClaim,
  isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess,
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
  recoverStaleTelegramSpooledUpdateClaims,
  refreshTelegramSpooledUpdateClaim,
  releaseTelegramSpooledUpdateClaim,
  resolveTelegramIngressSpoolDir,
  TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS,
  writeTelegramSpooledUpdate,
  type ClaimedTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";
import {
  buildTelegramReplyFenceLaneKey,
  supersedeTelegramReplyFenceLane,
} from "./telegram-reply-fence.js";
import { createTelegramWebhookStatusPublisher } from "./webhook-status.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS = 500;
const TELEGRAM_WEBHOOK_SPOOLED_CLAIM_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_WEBHOOK_SPOOLED_HANDLER_TIMEOUT_MS = 25 * 60_000;
const TELEGRAM_WEBHOOK_SPOOLED_HANDLER_ABORT_GRACE_MS = 5_000;
const TELEGRAM_WEBHOOK_SPOOLED_DRAIN_START_LIMIT = 100;
const TELEGRAM_WEBHOOK_SPOOLED_DRAIN_SCAN_LIMIT = TELEGRAM_WEBHOOK_SPOOLED_DRAIN_START_LIMIT * 10;
const TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};
const activeWebhookSpooledHandlersByLane = new Set<string>();

function buildWebhookSpooledHandlerKey(params: { laneKey: string; spoolDir: string }): string {
  return `${params.spoolDir}\0${params.laneKey}`;
}

function resolveActiveWebhookSpooledLaneKeys(spoolDir: string): Set<string> {
  const laneKeys = new Set<string>();
  const prefix = `${spoolDir}\0`;
  for (const handlerKey of activeWebhookSpooledHandlersByLane) {
    if (handlerKey.startsWith(prefix)) {
      laneKeys.add(handlerKey.slice(prefix.length));
    }
  }
  return laneKeys;
}

async function listenHttpServer(params: {
  server: ReturnType<typeof createServer>;
  port: number;
  host: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      params.server.off("error", onError);
      reject(err);
    };
    params.server.once("error", onError);
    params.server.listen(params.port, params.host, () => {
      params.server.off("error", onError);
      resolve();
    });
  });
}

function resolveWebhookPublicUrl(params: {
  configuredPublicUrl?: string;
  server: ReturnType<typeof createServer>;
  path: string;
  host: string;
  port: number;
}) {
  if (params.configuredPublicUrl) {
    return params.configuredPublicUrl;
  }
  const address = params.server.address();
  if (address && typeof address !== "string") {
    const resolvedHost =
      params.host === "0.0.0.0" || address.address === "0.0.0.0" || address.address === "::"
        ? "localhost"
        : address.address;
    return `http://${resolvedHost}:${address.port}${params.path}`;
  }
  const fallbackHost = params.host === "0.0.0.0" ? "localhost" : params.host;
  return `http://${fallbackHost}:${params.port}${params.path}`;
}

async function initializeTelegramWebhookBot(params: {
  bot: ReturnType<typeof createTelegramBot>;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const initSignal = params.abortSignal as Parameters<(typeof params.bot)["init"]>[0];
  await withTelegramApiErrorLogging({
    operation: "getMe",
    runtime: params.runtime,
    fn: () => params.bot.init(initSignal),
  });
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

function hasValidTelegramWebhookSecret(
  secretHeader: string | undefined,
  expectedSecret: string,
): boolean {
  return safeEqualSecret(secretHeader, expectedSecret);
}

function parseIpLiteral(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const candidate = trimmed.slice(1, end);
      return net.isIP(candidate) === 0 ? undefined : candidate;
    }
  }
  if (net.isIP(trimmed) !== 0) {
    return trimmed;
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > -1 && trimmed.includes(".") && trimmed.indexOf(":") === lastColon) {
    const candidate = trimmed.slice(0, lastColon);
    return net.isIP(candidate) === 4 ? candidate : undefined;
  }
  return undefined;
}

function isTrustedProxyAddress(
  ip: string | undefined,
  trustedProxies?: readonly string[],
): boolean {
  const candidate = parseIpLiteral(ip);
  if (!candidate || !trustedProxies?.length) {
    return false;
  }
  const blockList = new net.BlockList();
  for (const proxy of trustedProxies) {
    const trimmed = normalizeOptionalString(proxy) ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed.includes("/")) {
      const [address, prefix] = trimmed.split("/", 2);
      const parsedPrefix = parseStrictNonNegativeInteger(prefix);
      const family = net.isIP(address);
      if (family === 4 && parsedPrefix !== undefined && parsedPrefix >= 0 && parsedPrefix <= 32) {
        blockList.addSubnet(address, parsedPrefix, "ipv4");
      }
      if (family === 6 && parsedPrefix !== undefined && parsedPrefix >= 0 && parsedPrefix <= 128) {
        blockList.addSubnet(address, parsedPrefix, "ipv6");
      }
      continue;
    }
    if (net.isIP(trimmed) === 4) {
      blockList.addAddress(trimmed, "ipv4");
      continue;
    }
    if (net.isIP(trimmed) === 6) {
      blockList.addAddress(trimmed, "ipv6");
    }
  }
  return blockList.check(candidate, net.isIP(candidate) === 6 ? "ipv6" : "ipv4");
}

function resolveForwardedClientIp(
  forwardedFor: string | undefined,
  trustedProxies?: readonly string[],
): string | undefined {
  if (!trustedProxies?.length) {
    return undefined;
  }
  const forwardedChain = forwardedFor
    ?.split(",")
    .map((entry) => parseIpLiteral(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (!forwardedChain?.length) {
    return undefined;
  }
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    const hop = forwardedChain[index];
    if (!isTrustedProxyAddress(hop, trustedProxies)) {
      return hop;
    }
  }
  return undefined;
}

function resolveTelegramWebhookClientIp(req: IncomingMessage, config?: OpenClawConfig): string {
  const remoteAddress = parseIpLiteral(req.socket.remoteAddress);
  const trustedProxies = config?.gateway?.trustedProxies;
  if (!remoteAddress) {
    return "unknown";
  }
  if (!isTrustedProxyAddress(remoteAddress, trustedProxies)) {
    return remoteAddress;
  }
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const forwardedClientIp = resolveForwardedClientIp(forwardedFor, trustedProxies);
  if (forwardedClientIp) {
    return forwardedClientIp;
  }
  if (config?.gateway?.allowRealIpFallback === true) {
    const realIp = Array.isArray(req.headers["x-real-ip"])
      ? req.headers["x-real-ip"][0]
      : req.headers["x-real-ip"];
    return parseIpLiteral(realIp) ?? "unknown";
  }
  return "unknown";
}

function resolveTelegramWebhookRateLimitKey(
  req: IncomingMessage,
  path: string,
  config?: OpenClawConfig,
): string {
  return `${path}:${resolveTelegramWebhookClientIp(req, config)}`;
}

function resolveWebhookSpooledUpdateLaneKey(update: unknown): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
  });
}

async function releaseFailedWebhookSpooledUpdate(params: {
  err: unknown;
  log: (line: string) => void;
  update: ClaimedTelegramSpooledUpdate;
}): Promise<void> {
  const laneKey = resolveWebhookSpooledUpdateLaneKey(params.update.update);
  const nonRetryable = resolveNonRetryableSpooledUpdateFailure(params.err);
  if (nonRetryable) {
    const failed = await failTelegramSpooledUpdateClaim({
      update: params.update,
      reason: nonRetryable.reason,
      message: nonRetryable.message,
    });
    if (failed) {
      params.log(
        `[telegram][diag] webhook spooled update ${params.update.updateId} failed with non-retryable ${nonRetryable.reason}; dead-lettered: ${nonRetryable.message}`,
      );
    }
    return;
  }

  const attempt = resolveSpooledUpdateAttemptNumber(params.update);
  if (shouldDeadLetterRetryableSpooledUpdate(params.update, attempt)) {
    const message = formatErrorMessage(params.err);
    const failed = await failTelegramSpooledUpdateClaim({
      update: params.update,
      reason: "retry-limit-exceeded",
      message,
    });
    if (failed) {
      // Retryable poison updates must eventually become tombstones, but not
      // during ordinary transient provider or state-store outages.
      params.log(
        `[telegram][warn] webhook spooled update ${params.update.updateId} on lane ${laneKey} reached retry limit after ${attempt} attempts; dead-lettered: ${message}`,
      );
    }
    return;
  }

  await releaseTelegramSpooledUpdateClaim(params.update, {
    lastError: formatErrorMessage(params.err),
  });
  params.log(
    `[telegram][diag] webhook spooled update ${params.update.updateId} failed; keeping for retry attempt ${attempt + 1}/${TELEGRAM_SPOOLED_RETRY_MAX_ATTEMPTS}: ${formatErrorMessage(params.err)}`,
  );
}

function startWebhookSpooledUpdateClaimRefresh(params: {
  log: (line: string) => void;
  update: ClaimedTelegramSpooledUpdate;
}): () => void {
  let stopped = false;
  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (stopped || refreshing) {
      return;
    }
    refreshing = true;
    try {
      const refreshed = await refreshTelegramSpooledUpdateClaim(params.update);
      if (!refreshed && !stopped) {
        params.log(
          `[telegram][diag] webhook spooled update ${params.update.updateId} claim refresh lost ownership`,
        );
      }
    } catch (err) {
      params.log(
        `[telegram][diag] webhook spooled update ${params.update.updateId} claim refresh failed: ${formatErrorMessage(err)}`,
      );
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => {
    void refresh();
  }, TELEGRAM_WEBHOOK_SPOOLED_CLAIM_REFRESH_INTERVAL_MS);
  timer.unref?.();
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

type WebhookSpooledDeferredWorkResult = TelegramMessageProcessingResult & {
  timedOut?: boolean;
};

class WebhookSpooledHandlerTimeoutError extends Error {
  constructor(
    message: string,
    readonly replayTask: Promise<{ deferredWork?: TelegramSpooledReplayDeferredParticipant }>,
  ) {
    super(message);
    this.name = "WebhookSpooledHandlerTimeoutError";
  }
}

function formatWebhookSpooledHandlerTimeoutMessage(params: {
  laneKey: string;
  updateId: number;
}): string {
  const age = formatDurationPrecise(TELEGRAM_WEBHOOK_SPOOLED_HANDLER_TIMEOUT_MS);
  return `Telegram webhook spool processing timed out behind update ${params.updateId} on lane ${params.laneKey} after ${age}; marking the update failed.`;
}

async function failTimedOutWebhookSpooledUpdate(params: {
  log: (line: string) => void;
  message: string;
  update: ClaimedTelegramSpooledUpdate;
}): Promise<void> {
  const failed = await failTelegramSpooledUpdateClaim({
    update: params.update,
    reason: "handler-timeout",
    message: params.message,
  });
  if (!failed) {
    params.log(
      `[telegram][diag] timed out webhook spooled update ${params.update.updateId} no longer had a processing marker to fail.`,
    );
  }
}

async function waitForTimedOutWebhookReplayGrace(params: {
  log: (line: string) => void;
  replayTask: Promise<{ deferredWork?: TelegramSpooledReplayDeferredParticipant }>;
  updateId: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      params.replayTask.catch((replayErr: unknown) => {
        params.log(
          `[telegram][diag] timed out webhook spooled update ${params.updateId} replay later failed: ${formatErrorMessage(replayErr)}`,
        );
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TELEGRAM_WEBHOOK_SPOOLED_HANDLER_ABORT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runWebhookSpooledReplayWithTimeout(params: {
  bot: ReturnType<typeof createTelegramBot>;
  laneKey: string;
  rawUpdate: object;
  update: Parameters<ReturnType<typeof createTelegramBot>["handleUpdate"]>[0];
  updateId: number;
}): Promise<{ deferredWork?: TelegramSpooledReplayDeferredParticipant }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const replayTask = runWithTelegramSpooledReplayUpdate(params.rawUpdate, async () => {
    await params.bot.handleUpdate(params.update);
  });
  replayTask.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new WebhookSpooledHandlerTimeoutError(
          formatWebhookSpooledHandlerTimeoutMessage({
            laneKey: params.laneKey,
            updateId: params.updateId,
          }),
          replayTask,
        ),
      );
    }, TELEGRAM_WEBHOOK_SPOOLED_HANDLER_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([replayTask, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForWebhookSpooledDeferredWork(params: {
  deferredWork: TelegramSpooledReplayDeferredParticipant;
  laneKey: string;
  log: (line: string) => void;
  update: ClaimedTelegramSpooledUpdate;
}): Promise<WebhookSpooledDeferredWorkResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WebhookSpooledDeferredWorkResult>((resolve) => {
    timer = setTimeout(() => {
      const age = formatDurationPrecise(TELEGRAM_WEBHOOK_SPOOLED_HANDLER_TIMEOUT_MS);
      const message = `Telegram webhook spool buffered processing timed out behind update ${params.update.updateId} on lane ${params.laneKey} after ${age}; marking the update failed.`;
      params.log(`[telegram] ${message}`);
      params.deferredWork.settle({
        kind: "failed-retryable",
        error: new Error(message),
      });
      resolve({ kind: "failed-retryable", error: new Error(message), timedOut: true });
    }, TELEGRAM_WEBHOOK_SPOOLED_HANDLER_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      params.deferredWork.task.catch((err: unknown): TelegramMessageProcessingResult => {
        return { kind: "failed-retryable", error: err };
      }),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function handleWebhookSpooledUpdate(params: {
  accountId: string;
  bot: ReturnType<typeof createTelegramBot>;
  log: (line: string) => void;
  update: ClaimedTelegramSpooledUpdate;
}): Promise<void> {
  let replay: { deferredWork?: TelegramSpooledReplayDeferredParticipant };
  try {
    const rawUpdate = params.update.update;
    if (!rawUpdate || typeof rawUpdate !== "object") {
      throw new Error("Telegram spooled webhook update payload was invalid.");
    }
    const laneKey = resolveWebhookSpooledUpdateLaneKey(rawUpdate);
    const update = rawUpdate as Parameters<typeof params.bot.handleUpdate>[0];
    replay = await runWebhookSpooledReplayWithTimeout({
      bot: params.bot,
      laneKey,
      rawUpdate,
      update,
      updateId: params.update.updateId,
    });
  } catch (err) {
    if (err instanceof WebhookSpooledHandlerTimeoutError) {
      params.log(`[telegram] ${err.message}`);
      const scopedReplyFenceLaneKey = buildTelegramReplyFenceLaneKey({
        accountId: params.accountId,
        sequentialKey: resolveWebhookSpooledUpdateLaneKey(params.update.update),
      });
      const abortedReplyWork = supersedeTelegramReplyFenceLane(scopedReplyFenceLaneKey);
      if (!abortedReplyWork) {
        params.log(
          `[telegram][diag] timed out webhook spooled update ${params.update.updateId} had no active reply fence on lane ${scopedReplyFenceLaneKey}.`,
        );
      }
      await failTimedOutWebhookSpooledUpdate({
        log: params.log,
        message: err.message,
        update: params.update,
      });
      await waitForTimedOutWebhookReplayGrace({
        log: params.log,
        replayTask: err.replayTask,
        updateId: params.update.updateId,
      });
      return;
    }
    await releaseFailedWebhookSpooledUpdate({
      err,
      log: params.log,
      update: params.update,
    });
    return;
  }
  if (replay.deferredWork) {
    const result = await waitForWebhookSpooledDeferredWork({
      deferredWork: replay.deferredWork,
      laneKey: resolveWebhookSpooledUpdateLaneKey(params.update.update),
      log: params.log,
      update: params.update,
    });
    if (result.kind === "failed-retryable") {
      if (result.timedOut) {
        await failTimedOutWebhookSpooledUpdate({
          log: params.log,
          message: formatErrorMessage(result.error),
          update: params.update,
        });
        return;
      }
      await releaseFailedWebhookSpooledUpdate({
        err: result.error,
        log: params.log,
        update: params.update,
      });
      return;
    }
  }
  try {
    await completeTelegramSpooledUpdate(params.update);
  } catch (err) {
    params.log(
      `[telegram][diag] webhook spooled update ${params.update.updateId} completed but processing marker cleanup failed: ${formatErrorMessage(err)}`,
    );
  }
}

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
  webhookCertPath?: string;
  webhookRegistrationRetryPolicy?: BackoffPolicy;
  spoolDir?: string;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  const secret = normalizeOptionalString(opts.secret) ?? "";
  if (!secret) {
    throw new Error(
      "Telegram webhook mode requires a non-empty secret token. " +
        "Set channels.telegram.webhookSecret in your config.",
    );
  }
  const runtime = opts.runtime ?? defaultRuntime;
  const status = createTelegramWebhookStatusPublisher(opts.setStatus);
  status.noteWebhookStart();
  const webhookRegistrationRetryPolicy =
    opts.webhookRegistrationRetryPolicy ?? TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const spoolDir = opts.spoolDir ?? resolveTelegramIngressSpoolDir({ accountId: opts.accountId });
  let shutDown = false;
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  await initializeTelegramWebhookBot({
    bot,
    runtime,
    abortSignal: opts.abortSignal,
  });
  const telegramWebhookRateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(opts.config);
  }

  const log = (line: string) => runtime.log?.(line);
  let drainActive = false;
  let drainRequested = false;
  const drainWebhookSpool = async (): Promise<void> => {
    if (shutDown || opts.abortSignal?.aborted) {
      return;
    }
    if (drainActive) {
      drainRequested = true;
      return;
    }
    drainActive = true;
    drainRequested = false;
    try {
      const activeWebhookSpooledLaneKeys = resolveActiveWebhookSpooledLaneKeys(spoolDir);
      await recoverStaleTelegramSpooledUpdateClaims({
        spoolDir,
        staleMs: 0,
        shouldRecover: (claim) =>
          !activeWebhookSpooledLaneKeys.has(resolveWebhookSpooledUpdateLaneKey(claim.update)) &&
          !isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(claim, {
            maxAgeMs: TELEGRAM_SPOOLED_UPDATE_CLAIM_LEASE_MS,
          }),
      });
      const claimedLaneKeys = new Set(
        (
          await listTelegramSpooledUpdateClaims({
            spoolDir,
          })
        ).map((claim) => resolveWebhookSpooledUpdateLaneKey(claim.update)),
      );
      const updates = await listTelegramSpooledUpdates({
        spoolDir,
        limit: TELEGRAM_WEBHOOK_SPOOLED_DRAIN_SCAN_LIMIT,
      });
      const candidateUpdateIds = updates.map((update) => update.updateId);
      const blockedLaneKeys = new Set([...activeWebhookSpooledLaneKeys, ...claimedLaneKeys]);
      for (const update of updates) {
        // Release stamps lastAttemptAt; block the lane until backoff expires so
        // webhook replay cannot hot-loop a retryable poison update.
        if (resolveSpooledUpdateRetryDelayMs(update) > 0) {
          blockedLaneKeys.add(resolveWebhookSpooledUpdateLaneKey(update.update));
        }
      }
      let started = 0;
      while (started < TELEGRAM_WEBHOOK_SPOOLED_DRAIN_START_LIMIT) {
        if (shutDown || opts.abortSignal?.aborted) {
          break;
        }
        const claimedUpdate = await claimNextTelegramSpooledUpdate({
          spoolDir,
          blockedLaneKeys,
          candidateUpdateIds,
          scanLimit: TELEGRAM_WEBHOOK_SPOOLED_DRAIN_SCAN_LIMIT,
        });
        if (!claimedUpdate) {
          break;
        }
        const laneKey = resolveWebhookSpooledUpdateLaneKey(claimedUpdate.update);
        const handlerKey = buildWebhookSpooledHandlerKey({ spoolDir, laneKey });
        // Webhook HTTP requests and same-process restarts can overlap; keep
        // one process-global active claim per spool lane to preserve ordering.
        activeWebhookSpooledHandlersByLane.add(handlerKey);
        blockedLaneKeys.add(laneKey);
        // Claim ownership has a finite lease; refresh while the handler runs so
        // another process cannot recover and replay this update concurrently.
        const stopClaimRefresh = startWebhookSpooledUpdateClaimRefresh({
          log,
          update: claimedUpdate,
        });
        void handleWebhookSpooledUpdate({
          accountId: opts.accountId ?? "default",
          bot,
          log,
          update: claimedUpdate,
        })
          .catch((err: unknown) => {
            runtime.log?.(
              `[telegram][diag] webhook spooled update ${claimedUpdate.updateId} handler failed after claim: ${formatErrorMessage(err)}`,
            );
          })
          .finally(() => {
            stopClaimRefresh();
            activeWebhookSpooledHandlersByLane.delete(handlerKey);
            void Promise.resolve().then(drainWebhookSpool);
          });
        started += 1;
      }
    } catch (err) {
      runtime.log?.(`[telegram][diag] webhook spool drain failed: ${formatErrorMessage(err)}`);
    } finally {
      drainActive = false;
      if (drainRequested && !shutDown && !opts.abortSignal?.aborted) {
        void Promise.resolve().then(drainWebhookSpool);
      }
    }
  };
  const requestWebhookSpoolDrain = () => {
    void drainWebhookSpool();
  };
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  const startWebhookSpoolDrain = () => {
    if (drainTimer) {
      return;
    }
    requestWebhookSpoolDrain();
    drainTimer = setInterval(requestWebhookSpoolDrain, TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS);
    drainTimer.unref?.();
  };

  const server = createServer((req, res) => {
    const respondText = (statusCode: number, text = "") => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    };

    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    // Apply the per-source limit before auth so invalid secret guesses consume budget
    // in the same window as any later request from that source.
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter: telegramWebhookRateLimiter,
        rateLimitKey: resolveTelegramWebhookRateLimitKey(req, path, opts.config),
      })
    ) {
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }
    const secretHeader = resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]);
    if (!hasValidTelegramWebhookSecret(secretHeader, secret)) {
      res.shouldKeepAlive = false;
      res.setHeader("Connection", "close");
      respondText(401, "unauthorized");
      return;
    }
    void (async () => {
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
        emptyObjectOnEmpty: false,
      });
      if (!body.ok) {
        if (body.code === "PAYLOAD_TOO_LARGE") {
          respondText(413, body.error);
          return;
        }
        if (body.code === "REQUEST_BODY_TIMEOUT") {
          respondText(408, body.error);
          return;
        }
        if (body.code === "CONNECTION_CLOSED") {
          respondText(400, body.error);
          return;
        }
        respondText(400, body.error);
        return;
      }

      // Telegram sees 200 only after the update is durable. If SQLite rejects
      // the enqueue, this path returns non-200 so Telegram redelivers.
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: body.value,
        laneKey: resolveWebhookSpooledUpdateLaneKey(body.value),
      });
      // Enqueue duplicate detection makes Telegram webhook retries idempotent:
      // re-posted update_ids map to the same spool row and still ack fast.
      respondText(200);
      status.noteWebhookUpdateReceived();
      requestWebhookSpoolDrain();
      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    })().catch((err: unknown) => {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook request failed: ${errMsg}`);
      respondText(500);
    });
  });

  await listenHttpServer({
    server,
    port,
    host,
  });
  const boundAddress = server.address();
  const boundPort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : port;

  const publicUrl = resolveWebhookPublicUrl({
    configuredPublicUrl: opts.publicUrl,
    server,
    path,
    host,
    port,
  });

  let webhookAdvertised = false;
  const shutdown = () => {
    if (shutDown) {
      return;
    }
    shutDown = true;
    if (drainTimer) {
      clearInterval(drainTimer);
    }
    server.close();
    void bot.stop();
    status.noteWebhookStop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal?.aborted) {
    shutdown();
  } else if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
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
      status.noteWebhookRegistrationFailure(formatErrorMessage(err));
      throw err;
    }
    if (shutDown) {
      return;
    }
    webhookAdvertised = true;
    status.noteWebhookAdvertised();
    runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);
  };
  const shouldRetryWebhookRegistration = (err: unknown): boolean =>
    isRetryableTelegramApiError(err, { context: "webhook" });
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
        if (!shouldRetryWebhookRegistration(err)) {
          runtime.error?.(
            `telegram setWebhook retry stopped after non-recoverable error: ${formatErrorMessage(err)}`,
          );
          return;
        }
      }
      attempt += 1;
    }
  };
  const closeAfterStartupFailure = () => {
    shutDown = true;
    if (drainTimer) {
      clearInterval(drainTimer);
    }
    server.close();
    void bot.stop();
    status.noteWebhookStop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };

  runtime.log?.(`webhook local listener on http://${host}:${boundPort}${path}`);

  if (!shutDown) {
    try {
      await advertiseWebhook();
    } catch (err) {
      if (!shouldRetryWebhookRegistration(err)) {
        closeAfterStartupFailure();
        throw err;
      }
      void retryWebhookRegistration(1);
    }
  }
  // Drain only after registration succeeds or after the retrying startup path
  // is ready to return a stop handle; failed startup must not claim durable work.
  if (!shutDown) {
    startWebhookSpoolDrain();
  }

  return { server, bot, stop: shutdown };
}
