import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS = 30_000;
const FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV = "OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS";

function resolveStartupProbeTimeoutMs(): number {
  const raw = process.env[FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    console.warn(
      `[feishu] ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV}="${raw}" is invalid; using default ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS}ms`,
    );
  }
  return FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS;
}

export const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = resolveStartupProbeTimeoutMs();

type FetchBotOpenIdOptions = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

export type FeishuMonitorBotIdentity = {
  botOpenId?: string;
  botName?: string;
};

function isTimeoutErrorMessage(message: string | undefined): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return lower.includes("timeout") || lower.includes("timed out");
}

function isAbortErrorMessage(message: string | undefined): boolean {
  return normalizeLowercaseStringOrEmpty(message).includes("aborted");
}

// Serialise startup probes so concurrent gateway-driven startAccount calls
// (one per Feishu account via Promise.all) do not burst Feishu's bot-info
// endpoint from the same IP — which causes rotating timeouts (#63475).
let startupProbeQueue: Promise<unknown> = Promise.resolve();

async function fetchBotIdentityCore(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions,
): Promise<FeishuMonitorBotIdentity> {
  if (options.abortSignal?.aborted) {
    return {};
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  let result;
  try {
    result = await probeFeishu(account, {
      timeoutMs,
      abortSignal: options.abortSignal,
    });
  } catch {
    return {};
  }
  if (result.ok) {
    return { botOpenId: result.botOpenId, botName: result.botName };
  }

  const probeError = result.error ?? undefined;
  if (options.abortSignal?.aborted || isAbortErrorMessage(probeError)) {
    return {};
  }

  if (isTimeoutErrorMessage(probeError)) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`,
    );
  }
  return {};
}

export async function fetchBotIdentityForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
): Promise<FeishuMonitorBotIdentity> {
  // Short-circuit before joining the queue if already aborted.
  if (options.abortSignal?.aborted) {
    return {};
  }

  // Chain onto the shared queue so only one probe is in-flight at a time,
  // regardless of how many concurrent callers exist.
  const ticket = startupProbeQueue.then(() => fetchBotIdentityCore(account, options));
  // Swallow rejections in the queue itself so a failing probe does not block
  // subsequent accounts.
  startupProbeQueue = ticket.catch(() => {});

  // Race the queue wait against the abort signal so a stopped account does not
  // block behind another account's long probe timeout.
  if (options.abortSignal) {
    const signal = options.abortSignal;
    const abortRace = new Promise<FeishuMonitorBotIdentity>((resolve) => {
      signal.addEventListener("abort", () => resolve({}), { once: true });
    });
    return Promise.race([ticket, abortRace]);
  }

  return ticket;
}

/** Reset the startup probe queue (for testing). */
export function resetStartupProbeQueueForTest(): void {
  startupProbeQueue = Promise.resolve();
}

export async function fetchBotOpenIdForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
): Promise<string | undefined> {
  const identity = await fetchBotIdentityForMonitor(account, options);
  return identity.botOpenId;
}
