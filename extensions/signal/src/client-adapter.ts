/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the appropriate implementation
 * based on the configured API mode. Exports mirror client.ts names so consumers
 * only need to change their import path.
 */

import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  containerCheck,
  containerRpcRequest,
  streamContainerEvents,
  containerFetchAttachment,
} from "./client-container.js";
import type { SignalRpcOptions } from "./client.js";
import {
  signalCheck as nativeCheck,
  signalReceiveCheck as nativeReceiveCheck,
  signalRpcRequest as nativeRpcRequest,
  streamSignalEvents as nativeStreamEvents,
} from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MODE_CACHE_TTL_MS = 30_000;
const NATIVE_PREFERENCE_GRACE_MS = 50;

export type SignalSseEvent = {
  event?: string;
  data?: string;
};

export type SignalApiMode = "native" | "container" | "auto";

// Re-export the options type so consumers can import it from the adapter.
export type { SignalRpcOptions } from "./client.js";

// Cache auto-detected modes per baseUrl to avoid repeated network probes.
const detectedModeCache = new Map<
  string,
  { mode: "native" | "container"; expiresAt: number; receiveAccount?: string }
>();

function resolveConfiguredApiMode(configured?: SignalApiMode): SignalApiMode {
  if (configured === "native" || configured === "container") {
    return configured;
  }
  return "auto";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAutoProbeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function waitForNativePreferenceGrace(
  nativeResultPromise: Promise<{ ok: boolean }>,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), NATIVE_PREFERENCE_GRACE_MS);
    timer.unref?.();
    void nativeResultPromise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

export type SignalCheckResult = { ok: boolean; status?: number | null; error?: string | null };
export type SignalApiCheck = {
  mode: "native" | "container" | null;
  check: SignalCheckResult;
};
type SignalApiDetection = { mode: "native" | "container"; check: SignalCheckResult };
type SignalApiDetectionOptions = {
  account?: string;
  requireReceive?: boolean;
  checkNativeReceive?: boolean;
};

function resolveReceiveAccountCacheValue(params: {
  mode: "native" | "container";
  receiveAccount?: string;
  options: SignalApiDetectionOptions;
}): string | undefined {
  if (!params.options.requireReceive || !params.receiveAccount) {
    return undefined;
  }
  if (params.mode === "native" && params.options.checkNativeReceive === false) {
    return undefined;
  }
  return params.receiveAccount;
}

function canReuseDetectedMode(params: {
  cached: { mode: "native" | "container"; receiveAccount?: string };
  receiveAccount?: string;
  options: SignalApiDetectionOptions;
}): boolean {
  if (!params.options.requireReceive) {
    return true;
  }
  if (params.cached.mode === "native" && params.options.checkNativeReceive === false) {
    return true;
  }
  return Boolean(params.receiveAccount && params.cached.receiveAccount === params.receiveAccount);
}

function createSignalApiNotReachableError(
  baseUrl: string,
  nativeResult: SignalCheckResult,
  containerResult: SignalCheckResult,
  options: { requireReceive?: boolean },
): Error {
  if (options.requireReceive && containerResult.error?.includes("receive")) {
    const error = new Error(containerResult.error);
    Object.assign(error, {
      signalCheckResult: containerResult,
    });
    return error;
  }
  if (options.requireReceive && nativeResult.error?.includes("receive")) {
    const error = new Error(nativeResult.error);
    Object.assign(error, {
      signalCheckResult: nativeResult,
    });
    return error;
  }
  return new Error(`Signal API not reachable at ${baseUrl}`);
}

async function checkNativeApi(
  baseUrl: string,
  timeoutMs: number,
  options: SignalApiDetectionOptions,
): Promise<SignalCheckResult> {
  const check = await nativeCheck(baseUrl, timeoutMs);
  if (!check.ok || !options.requireReceive || options.checkNativeReceive === false) {
    return check;
  }
  return nativeReceiveCheck(baseUrl, timeoutMs, options.account?.trim());
}

async function resolveAutoApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SignalApiDetectionOptions = {},
): Promise<"native" | "container"> {
  const receiveAccount = options.account?.trim();
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  const cached = detectedModeCache.get(baseUrl);
  if (cached) {
    if (now !== undefined && cached.expiresAt > now) {
      if (canReuseDetectedMode({ cached, receiveAccount, options })) {
        return cached.mode;
      }
    } else {
      detectedModeCache.delete(baseUrl);
    }
  }
  const detected = await detectSignalApiMode(baseUrl, timeoutMs, options);
  const expiresAt = resolveExpiresAtMsFromDurationMs(MODE_CACHE_TTL_MS, { nowMs: rawNow });
  if (expiresAt !== undefined) {
    const cachedReceiveAccount = resolveReceiveAccountCacheValue({
      mode: detected,
      receiveAccount,
      options,
    });
    detectedModeCache.set(baseUrl, {
      mode: detected,
      expiresAt,
      ...(cachedReceiveAccount ? { receiveAccount: cachedReceiveAccount } : {}),
    });
  }
  return detected;
}

async function checkDetectedSignalApiMode(
  baseUrl: string,
  timeoutMs: number,
  mode: "native" | "container",
  options: SignalApiDetectionOptions,
): Promise<SignalCheckResult> {
  if (mode === "container") {
    return options.requireReceive
      ? containerCheck(baseUrl, timeoutMs, options.account?.trim())
      : containerCheck(baseUrl, timeoutMs);
  }
  return checkNativeApi(baseUrl, timeoutMs, options);
}

async function resolveAutoApiDetection(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SignalApiDetectionOptions = {},
): Promise<SignalApiDetection> {
  const receiveAccount = options.account?.trim();
  const rawNow = Date.now();
  const now = asDateTimestampMs(rawNow);
  const cached = detectedModeCache.get(baseUrl);
  if (cached) {
    if (now !== undefined && cached.expiresAt > now) {
      if (canReuseDetectedMode({ cached, receiveAccount, options })) {
        return {
          mode: cached.mode,
          check: await checkDetectedSignalApiMode(baseUrl, timeoutMs, cached.mode, options),
        };
      }
    } else {
      detectedModeCache.delete(baseUrl);
    }
  }
  const detected = await detectSignalApiModeWithCheck(baseUrl, timeoutMs, options);
  const expiresAt = resolveExpiresAtMsFromDurationMs(MODE_CACHE_TTL_MS, { nowMs: rawNow });
  if (expiresAt !== undefined) {
    const cachedReceiveAccount = resolveReceiveAccountCacheValue({
      mode: detected.mode,
      receiveAccount,
      options,
    });
    detectedModeCache.set(baseUrl, {
      mode: detected.mode,
      expiresAt,
      ...(cachedReceiveAccount ? { receiveAccount: cachedReceiveAccount } : {}),
    });
  }
  return detected;
}

async function resolveApiModeForOperation(params: {
  baseUrl: string;
  accountId?: string;
  account?: string;
  requireReceive?: boolean;
  timeoutMs?: number;
  apiMode?: SignalApiMode;
}): Promise<"native" | "container"> {
  const configured = resolveConfiguredApiMode(params.apiMode);

  if (configured === "native" || configured === "container") {
    return configured;
  }

  return resolveAutoApiMode(params.baseUrl, params.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
    account: params.account,
    requireReceive: params.requireReceive,
    // Native streaming owns the long-lived receive path; probing it here can hang
    // before headers. Container still needs the finite WebSocket readiness check.
    checkNativeReceive: false,
  });
}

/**
 * Detect which Signal API mode is available by probing endpoints.
 * Native wins when both APIs are healthy because it preserves the richer JSON-RPC contract.
 */
export async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { account?: string; requireReceive?: boolean } = {},
): Promise<"native" | "container"> {
  return (await detectSignalApiModeWithCheck(baseUrl, timeoutMs, options)).mode;
}

async function detectSignalApiModeWithCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SignalApiDetectionOptions = {},
): Promise<SignalApiDetection> {
  const containerAccount = options.requireReceive ? options.account?.trim() : undefined;
  const nativeResultPromise = checkNativeApi(baseUrl, timeoutMs, options).catch(() => ({
    ok: false,
  }));
  const containerResultPromise = containerAccount
    ? containerCheck(baseUrl, timeoutMs, containerAccount).catch(() => ({ ok: false }))
    : options.requireReceive
      ? Promise.resolve({ ok: false })
      : containerCheck(baseUrl, timeoutMs).catch(() => ({ ok: false }));

  const nativeHealthyPromise = nativeResultPromise.then((result) => {
    if (result.ok) {
      return { mode: "native" as const, check: result };
    }
    throw new Error("native not ok");
  });
  const containerHealthyPromise = containerResultPromise.then((result) => {
    if (result.ok) {
      return { mode: "container" as const, check: result };
    }
    throw new Error("container not ok");
  });

  try {
    const firstHealthy = await Promise.any([nativeHealthyPromise, containerHealthyPromise]);
    if (firstHealthy.mode === "native") {
      return firstHealthy;
    }
    const nativeResult = await waitForNativePreferenceGrace(nativeResultPromise);
    return nativeResult.ok
      ? { mode: "native", check: nativeResult }
      : { mode: "container", check: firstHealthy.check };
  } catch {
    throw createSignalApiNotReachableError(
      baseUrl,
      await nativeResultPromise,
      await containerResultPromise,
      { requireReceive: options.requireReceive },
    );
  }
}

/**
 * Drop-in replacement for native signalRpcRequest.
 * Routes to native JSON-RPC or container REST based on config.
 */
export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions & {
    accountId?: string;
    apiMode?: SignalApiMode;
    maxAttachmentBytes?: number;
  },
): Promise<T> {
  const mode = await resolveApiModeForOperation({
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    account: typeof params?.account === "string" ? params.account : undefined,
    timeoutMs: opts.timeoutMs,
    apiMode: opts.apiMode,
  });
  if (mode === "native") {
    return nativeRpcRequest<T>(method, params, opts);
  }
  return containerRpcRequest<T>(method, params, opts);
}

/**
 * Drop-in replacement for native signalCheck.
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { apiMode?: SignalApiMode; account?: string; requireReceive?: boolean } = {},
): Promise<SignalCheckResult> {
  return (await signalCheckWithMode(baseUrl, timeoutMs, options)).check;
}

export async function signalCheckWithMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { apiMode?: SignalApiMode; account?: string; requireReceive?: boolean } = {},
): Promise<SignalApiCheck> {
  const configured = resolveConfiguredApiMode(options.apiMode);
  if (configured === "auto") {
    return await resolveAutoApiDetection(baseUrl, timeoutMs, {
      account: options.account,
      requireReceive: options.requireReceive,
    }).catch((error: unknown) => {
      const result =
        typeof error === "object" && error !== null
          ? (error as { signalCheckResult?: SignalCheckResult }).signalCheckResult
          : undefined;
      return {
        mode: null,
        check: {
          ok: false,
          status: result?.status ?? null,
          error: result?.error ?? formatErrorMessage(error),
        },
      } satisfies SignalApiCheck;
    });
  }
  return {
    mode: configured,
    check: await checkDetectedSignalApiMode(baseUrl, timeoutMs, configured, {
      account: options.account,
      requireReceive: options.requireReceive,
    }),
  };
}

/**
 * Drop-in replacement for native streamSignalEvents.
 * Container mode uses WebSocket; native uses SSE.
 */
export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (event: SignalSseEvent) => void;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
  apiMode?: SignalApiMode;
}): Promise<void> {
  const mode = await resolveApiModeForOperation({
    baseUrl: params.baseUrl,
    accountId: params.accountId,
    account: params.account,
    requireReceive: true,
    timeoutMs: resolveAutoProbeTimeoutMs(params.timeoutMs),
    apiMode: params.apiMode,
  });

  if (mode === "container") {
    return streamContainerEvents({
      baseUrl: params.baseUrl,
      account: params.account,
      abortSignal: params.abortSignal,
      timeoutMs: params.timeoutMs,
      onEvent: (event) => params.onEvent({ event: "receive", data: JSON.stringify(event) }),
      logger: params.logger,
    });
  }

  return nativeStreamEvents({
    baseUrl: params.baseUrl,
    account: params.account,
    abortSignal: params.abortSignal,
    timeoutMs: params.timeoutMs,
    onEvent: (event) => params.onEvent(event),
  });
}

/**
 * Fetch attachment, routing to native or container implementation.
 */
export async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  attachmentId: string;
  sender?: string;
  groupId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  apiMode?: SignalApiMode;
}): Promise<Buffer | null> {
  const mode = await resolveApiModeForOperation({
    baseUrl: params.baseUrl,
    accountId: params.accountId,
    account: params.account,
    timeoutMs: params.timeoutMs,
    apiMode: params.apiMode,
  });
  if (mode === "container") {
    return containerFetchAttachment(params.attachmentId, {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      maxResponseBytes: params.maxResponseBytes,
    });
  }

  const rpcParams: Record<string, unknown> = {
    id: params.attachmentId,
  };
  if (params.account) {
    rpcParams.account = params.account;
  }
  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else if (params.sender) {
    rpcParams.recipient = params.sender;
  } else {
    return null;
  }
  const result = await nativeRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    maxResponseBytes: params.maxResponseBytes,
  });
  if (!result?.data) {
    return null;
  }
  return Buffer.from(result.data, "base64");
}
