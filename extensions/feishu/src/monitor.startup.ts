import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import {
  asOptionalObjectRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { probeFeishu, registerFeishuAiAgent } from "./probe.js";
import { getFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_BOT_IDENTITY_CACHE_NAMESPACE = "feishu.bot-identity-cache";

const FEISHU_BOT_IDENTITY_CACHE_MAX_ENTRIES = 128;

type FeishuBotIdentityCacheState = {
  appId: string;
  botOpenId: string;
  botName?: string;
  fetchedAt: string;
};

function openFeishuBotIdentityCache() {
  return getFeishuRuntime().state.openKeyedStore<FeishuBotIdentityCacheState>({
    namespace: FEISHU_BOT_IDENTITY_CACHE_NAMESPACE,
    maxEntries: FEISHU_BOT_IDENTITY_CACHE_MAX_ENTRIES,
  });
}

function parseCachedFeishuBotIdentity(value: unknown): FeishuBotIdentityCacheState | null {
  const state = asOptionalObjectRecord(value);
  if (!state) {
    return null;
  }
  const appId = normalizeOptionalString(state.appId);
  const botOpenId = normalizeOptionalString(state.botOpenId);
  const fetchedAt = normalizeOptionalString(state.fetchedAt);
  if (!appId || !botOpenId || !fetchedAt || Number.isNaN(Date.parse(fetchedAt))) {
    return null;
  }
  return { appId, botOpenId, fetchedAt };
}

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = resolveStartupProbeTimeoutMs();

export type FeishuMonitorBotIdentity = {
  botOpenId?: string;
  source?: "provider" | "cache";
};

export async function fetchBotIdentityForMonitor(
  account: ResolvedFeishuAccount,
  options: {
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    allowCachedFallback?: boolean;
  } = {},
): Promise<FeishuMonitorBotIdentity> {
  if (options.abortSignal?.aborted) {
    return {};
  }

  const timeoutMs = FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  const result = await probeFeishu(account, {
    timeoutMs,
    abortSignal: options.abortSignal,
  });
  const resultAppId = normalizeOptionalString(result.appId);
  if (result.ok && resultAppId === account.appId) {
    // AI-agent registration is provider metadata, not channel identity. Keep it
    // best-effort so its quota or availability cannot suppress message ingress.
    void registerFeishuAiAgent(account, { abortSignal: options.abortSignal })
      .then((registration) => {
        if (!registration.ok && registration.reason !== "aborted") {
          const log = options.runtime?.log ?? console.log;
          log(
            `feishu[${account.accountId}]: AI-agent registration unavailable (${registration.reason}); continuing with standard bot identity`,
          );
        }
      })
      .catch(() => {
        const log = options.runtime?.log ?? console.log;
        log(
          `feishu[${account.accountId}]: AI-agent registration failed unexpectedly; continuing with standard bot identity`,
        );
      });
    try {
      const appId = normalizeOptionalString(account.appId);
      const botOpenId = normalizeOptionalString(result.botOpenId);
      if (appId && botOpenId) {
        const botName = normalizeOptionalString(result.botName);
        await openFeishuBotIdentityCache().register(normalizeAccountId(account.accountId), {
          appId,
          botOpenId,
          botName,
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch {
      options.runtime?.log(
        `feishu[${account.accountId}]: bot identity cache write failed; continuing startup`,
      );
    }
    return {
      botOpenId: normalizeOptionalString(result.botOpenId),
      source: "provider",
    };
  }

  if (result.ok) {
    const log = options.runtime?.log ?? console.log;
    log(
      `feishu[${account.accountId}]: bot info check returned identity for a different app; ignoring stale result`,
    );
  }

  const probeError = normalizeLowercaseStringOrEmpty(result.error);
  if (options.abortSignal?.aborted || probeError.includes("aborted")) {
    return {};
  }

  if (probeError.includes("timeout") || probeError.includes("timed out")) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info check timed out after ${timeoutMs}ms; continuing startup`,
    );
  }
  if (options.allowCachedFallback === false) {
    return {};
  }
  try {
    const appId = normalizeOptionalString(account.appId);
    if (!appId) {
      return {};
    }
    const cached = parseCachedFeishuBotIdentity(
      await openFeishuBotIdentityCache().lookup(normalizeAccountId(account.accountId)),
    );
    // The app id is the stable provider identity boundary. Secret rotation keeps
    // this cache valid; changing apps must never reuse another bot's identity.
    if (!cached || cached.appId !== appId) {
      return {};
    }
    options.runtime?.log(
      `feishu[${account.accountId}]: using cached provider-verified bot identity while the fresh check is unavailable`,
    );
    return { botOpenId: cached.botOpenId, source: "cache" };
  } catch {
    options.runtime?.log(
      `feishu[${account.accountId}]: bot identity cache read failed; continuing without cached identity`,
    );
    return {};
  }
}
