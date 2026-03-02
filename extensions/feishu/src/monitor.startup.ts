import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";

export const FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS = 10_000;

type FetchBotOpenIdOptions = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

function isTimeoutErrorMessage(message: string | undefined): boolean {
  return message?.toLowerCase().includes("timeout") || message?.toLowerCase().includes("timed out")
    ? true
    : false;
}

function isAbortErrorMessage(message: string | undefined): boolean {
  return message?.toLowerCase().includes("aborted") ?? false;
}

export async function fetchBotOpenIdForMonitor(
  account: ResolvedFeishuAccount,
  options: FetchBotOpenIdOptions = {},
): Promise<string | undefined> {
  if (options.abortSignal?.aborted) {
    return undefined;
  }

  const timeoutMs = options.timeoutMs ?? FEISHU_STARTUP_BOT_INFO_TIMEOUT_MS;
  const result = await probeFeishu(account, {
    timeoutMs,
    abortSignal: options.abortSignal,
  });
  if (result.ok) {
    return result.botOpenId;
  }

  if (options.abortSignal?.aborted || isAbortErrorMessage(result.error)) {
    return undefined;
  }

  if (isTimeoutErrorMessage(result.error)) {
    const error = options.runtime?.error ?? console.error;
    error(
      `feishu[${account.accountId}]: bot info probe timed out after ${timeoutMs}ms; continuing startup`,
    );
  }
  return undefined;
}
