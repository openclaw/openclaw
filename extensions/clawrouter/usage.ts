import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { normalizeClawRouterRootUrl } from "./provider-catalog.js";

type ClawRouterBudget = {
  configured?: unknown;
  ledger?: unknown;
  windowKey?: unknown;
  limitMicros?: unknown;
  spentMicros?: unknown;
  remainingMicros?: unknown;
};

type ClawRouterUsagePayload = {
  budget?: ClawRouterBudget;
  usage?: {
    summary?: {
      requestCount?: unknown;
      totalTokens?: unknown;
      actualCostMicros?: unknown;
    };
  };
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000;
  return dollars < 0.01 && dollars > 0 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function resolveMonthlyResetAt(windowKey: unknown): number | undefined {
  if (typeof windowKey !== "string") {
    return undefined;
  }
  const match = windowKey.match(/\/(\d{4})-(\d{2})$/u);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return Number.isSafeInteger(year) && month >= 1 && month <= 12
    ? Date.UTC(year, month, 1)
    : undefined;
}

function buildSummary(payload: ClawRouterUsagePayload): string | undefined {
  const summary = payload.usage?.summary;
  const requests = nonNegativeNumber(summary?.requestCount);
  const tokens = nonNegativeNumber(summary?.totalTokens);
  const costMicros = nonNegativeNumber(summary?.actualCostMicros);
  const parts = [
    requests === undefined ? undefined : `${formatCount(requests)} requests`,
    tokens === undefined ? undefined : `${formatCount(tokens)} tokens`,
    costMicros === undefined ? undefined : `${formatUsd(costMicros)} used`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export async function fetchClawRouterUsage(params: {
  token: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const response = await params.fetchFn(`${normalizeClawRouterRootUrl(params.baseUrl)}/v1/usage`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.token}`,
    },
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ClawRouter usage request failed (HTTP ${response.status})`);
  }
  const payload = (await response.json()) as ClawRouterUsagePayload;
  const budget = payload.budget;
  const limitMicros = nonNegativeNumber(budget?.limitMicros);
  const spentMicros = nonNegativeNumber(budget?.spentMicros);
  const windows = [];
  if (budget?.configured === true && limitMicros !== undefined && spentMicros !== undefined) {
    windows.push({
      label: "Monthly budget",
      usedPercent: limitMicros === 0 ? 100 : Math.min(100, (spentMicros / limitMicros) * 100),
      resetAt: resolveMonthlyResetAt(budget?.windowKey),
    });
  }
  return {
    provider: "clawrouter" as ProviderUsageSnapshot["provider"],
    displayName: "ClawRouter",
    windows,
    summary: buildSummary(payload),
    plan: budget?.configured === true ? "Managed monthly budget" : "Unmetered proxy key",
  };
}
