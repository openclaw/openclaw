import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { readCachedFeishuBotIdentity, writeCachedFeishuBotIdentity } from "./bot-identity-cache.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { probeFeishu, registerFeishuAiAgent } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = resolveStartupProbeTimeoutMs();

type FetchBotOpenIdOptions = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  allowCachedFallback?: boolean;
};

export type FeishuMonitorBotIdentity = {
  botOpenId?: string;
  botName?: string;
  source?: "provider" | "cache";
};

export async function fetchBotIdentityForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
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
      await writeCachedFeishuBotIdentity({
        accountId: account.accountId,
        appId: account.appId,
        botOpenId: result.botOpenId,
        botName: result.botName,
      });
    } catch {
      options.runtime?.log?.(
        `feishu[${account.accountId}]: bot identity cache write failed; continuing startup`,
      );
    }
    return {
      botOpenId: normalizeOptionalString(result.botOpenId),
      botName: normalizeOptionalString(result.botName),
      source: "provider",
    };
  }

  if (result.ok) {
    const log = options.runtime?.log ?? console.log;
    log(
      `feishu[${account.accountId}]: bot info probe returned identity for a different app; ignoring stale result`,
    );
  }

  const probeError = normalizeLowercaseStringOrEmpty(result.error);
  if (options.abortSignal?.aborted || probeError.includes("aborted")) {
    return {};
  }

  if (probeError.includes("timeout") || probeError.includes("timed out")) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`,
    );
  }
  if (options.allowCachedFallback === false) {
    return {};
  }
  try {
    const cached = await readCachedFeishuBotIdentity({
      accountId: account.accountId,
      appId: account.appId,
    });
    if (!cached) {
      return {};
    }
    options.runtime?.log?.(
      `feishu[${account.accountId}]: using cached provider-verified bot identity while the fresh probe is unavailable`,
    );
    return { botOpenId: cached.botOpenId, botName: cached.botName, source: "cache" };
  } catch {
    options.runtime?.log?.(
      `feishu[${account.accountId}]: bot identity cache read failed; continuing without cached identity`,
    );
    return {};
  }
}
