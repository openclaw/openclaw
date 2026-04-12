import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

const QA_BUS_UNAVAILABLE_RESTART_POLICY = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function collectErrorCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current !== "object") {
      continue;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      codes.add(code.trim().toUpperCase());
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause && !seen.has(cause)) {
      queue.push(cause);
    }
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const nested of errors) {
        if (nested && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  return codes;
}

function isLocalQaBusUnavailable(baseUrl: string, error: unknown): boolean {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.trim().toLowerCase();
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostname)) {
    return false;
  }
  return collectErrorCodes(error).has("ECONNREFUSED");
}

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let unavailableRestartAttempt = 0;
  try {
    while (!ctx.abortSignal.aborted) {
      try {
        const result = await pollQaBus({
          baseUrl: account.baseUrl,
          accountId: account.accountId,
          cursor,
          timeoutMs: account.pollTimeoutMs,
          signal: ctx.abortSignal,
        });
        unavailableRestartAttempt = 0;
        ctx.setStatus({
          accountId: account.accountId,
          connected: true,
          healthState: "healthy",
          healthMonitorSuppressedUntil: undefined,
          healthMonitorSuppressionReason: undefined,
          lastError: null,
        });
        cursor = result.cursor;
        for (const event of result.events) {
          if (event.kind !== "inbound-message") {
            continue;
          }
          ctx.setStatus({
            accountId: account.accountId,
            lastEventAt: Date.now(),
            lastInboundAt: Date.now(),
          });
          await handleQaInbound({
            channelId,
            channelLabel,
            account,
            config: ctx.cfg as CoreConfig,
            message: event.message,
          });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        if (!isLocalQaBusUnavailable(account.baseUrl, error)) {
          throw error;
        }
        unavailableRestartAttempt += 1;
        const delayMs = computeBackoff(
          QA_BUS_UNAVAILABLE_RESTART_POLICY,
          unavailableRestartAttempt,
        );
        const suppressedUntil = Date.now() + delayMs;
        const errorMessage =
          error instanceof Error ? error.message : `qa-bus unavailable: ${String(error)}`;
        ctx.setStatus({
          accountId: account.accountId,
          connected: false,
          healthState: "qa-bus-unavailable",
          healthMonitorSuppressedUntil: suppressedUntil,
          healthMonitorSuppressionReason: "qa-bus-unavailable",
          lastError: errorMessage,
        });
        ctx.log?.warn?.(
          `[${account.accountId}] qa-bus unavailable at ${account.baseUrl}; retrying in ${Math.round(delayMs / 1000)}s`,
        );
        await sleepWithAbort(delayMs, ctx.abortSignal);
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: false,
    connected: false,
    healthMonitorSuppressedUntil: undefined,
    healthMonitorSuppressionReason: undefined,
  });
}
