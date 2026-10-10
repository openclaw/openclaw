import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  asProviderUsageObject,
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  parseProviderUsageNonNegativeNumber,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { OLLAMA_DEFAULT_API_KEY } from "./defaults.js";

const MAX_BALANCE_RESPONSE_BYTES = 64 * 1024;

function readResetAt(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPercentWindow(value: unknown, label: string): UsageWindow | undefined {
  const record = asProviderUsageObject(value);
  const remaining = parseProviderUsageNonNegativeNumber(record?.remaining_percent);
  if (remaining === undefined || remaining > 100) {
    return undefined;
  }
  const resetAt = readResetAt(record?.resets_at);
  return {
    label,
    usedPercent: clampPercent(100 - remaining),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export async function fetchOllamaUsage(params: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  let response: Response;
  try {
    response = await fetchJson(
      `${params.baseUrl.replace(/\/+$/, "")}/api/balance`,
      {
        headers: {
          Accept: "application/json",
          ...(params.token !== OLLAMA_DEFAULT_API_KEY
            ? { Authorization: `Bearer ${params.token}` }
            : {}),
        },
      },
      params.timeoutMs,
      params.fetchFn,
    );
  } catch {
    return buildUsageErrorSnapshot("ollama", "Usage unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      return buildUsageErrorSnapshot("ollama", "Sign in to Ollama Cloud on the configured server");
    }
    if (response.status === 404) {
      return buildUsageErrorSnapshot("ollama", "Update the configured Ollama server to 0.40.1+");
    }
    return buildUsageHttpErrorSnapshot({ provider: "ollama", status: response.status });
  }

  let data: Record<string, unknown>;
  try {
    data = await readProviderJsonObjectResponse(response, "Ollama balance", {
      maxBytes: MAX_BALANCE_RESPONSE_BYTES,
      chunkTimeoutMs: params.timeoutMs,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`Ollama balance response stalled for ${chunkTimeoutMs}ms`),
    });
  } catch {
    return buildUsageErrorSnapshot("ollama", "Malformed balance response");
  }

  const included = asProviderUsageObject(data.included);
  const purchased = asProviderUsageObject(data.purchased);
  const windows = [
    readPercentWindow(included?.session, "Session"),
    readPercentWindow(included?.weekly, "Week"),
  ].filter((window): window is UsageWindow => window !== undefined);
  const allowance = parseProviderUsageNonNegativeNumber(included?.allowance_usd);
  const balance = parseProviderUsageNonNegativeNumber(included?.balance_usd);
  const period = asProviderUsageObject(included?.period);
  const resetAt = readResetAt(period?.until);
  if (allowance !== undefined && allowance > 0 && balance !== undefined) {
    windows.push({
      label: "Included",
      usedPercent: clampPercent(((allowance - balance) / allowance) * 100),
      ...(resetAt !== undefined ? { resetAt } : {}),
    });
  }

  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  if (balance !== undefined) {
    billing.push({ type: "balance", label: "Included balance", amount: balance, unit: "USD" });
  }
  const purchasedBalance = parseProviderUsageNonNegativeNumber(purchased?.balance_usd);
  if (purchasedBalance !== undefined) {
    billing.push({
      type: "balance",
      label: "Purchased balance",
      amount: purchasedBalance,
      unit: "USD",
    });
  }
  if (windows.length === 0 && billing.length === 0) {
    return buildUsageErrorSnapshot("ollama", "No balance data");
  }
  return {
    provider: "ollama",
    displayName: "Ollama",
    windows,
    ...(billing.length > 0 ? { billing } : {}),
  };
}
