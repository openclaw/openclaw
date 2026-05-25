import {
  buildUsageHttpErrorSnapshot,
  fetchJson,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";

type OpenRouterCreditsResponse = {
  data?: {
    total_credits?: number | string | null;
    total_usage?: number | string | null;
  };
};

type OpenRouterKeyResponse = {
  data?: {
    limit?: number | string | null;
    limit_remaining?: number | string | null;
    limit_reset?: string | null;
    usage?: number | string | null;
    usage_daily?: number | string | null;
    usage_weekly?: number | string | null;
    usage_monthly?: number | string | null;
  };
};

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function usagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (used / total) * 100));
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchOpenRouterUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const [creditsRes, keyRes] = await Promise.all([
    fetchJson(
      "https://openrouter.ai/api/v1/credits",
      { method: "GET", headers },
      timeoutMs,
      fetchFn,
    ),
    fetchJson("https://openrouter.ai/api/v1/key", { method: "GET", headers }, timeoutMs, fetchFn),
  ]);

  const windows: ProviderUsageSnapshot["windows"] = [];
  const errors: string[] = [];

  if (creditsRes.ok) {
    const credits = await readJson<OpenRouterCreditsResponse>(creditsRes);
    const totalCredits = parseNumber(credits?.data?.total_credits);
    const totalUsage = parseNumber(credits?.data?.total_usage);
    if (totalCredits !== undefined && totalUsage !== undefined) {
      const remaining = totalCredits - totalUsage;
      windows.push({
        label: "Credits",
        usedPercent: usagePercent(totalUsage, totalCredits),
        remainingLabel: formatUsd(remaining),
        usedLabel: formatUsd(totalUsage),
        totalLabel: formatUsd(totalCredits),
      });
    }
  } else if (creditsRes.status !== 403) {
    errors.push(
      buildUsageHttpErrorSnapshot({
        provider: "openrouter",
        status: creditsRes.status,
      }).error ?? `HTTP ${creditsRes.status}`,
    );
  }

  if (keyRes.ok) {
    const key = await readJson<OpenRouterKeyResponse>(keyRes);
    const limit = parseNumber(key?.data?.limit);
    const remaining = parseNumber(key?.data?.limit_remaining);
    const usage = parseNumber(key?.data?.usage);
    if (limit !== undefined && remaining !== undefined) {
      windows.push({
        label: key?.data?.limit_reset ? `Key limit (${key.data.limit_reset})` : "Key limit",
        usedPercent: usagePercent(Math.max(0, limit - remaining), limit),
        remainingLabel: formatUsd(remaining),
        totalLabel: formatUsd(limit),
      });
    } else if (usage !== undefined) {
      windows.push({
        label: "Key usage",
        usedPercent: 0,
        usedLabel: formatUsd(usage),
        remainingLabel: "unlimited",
      });
    }
  } else if (keyRes.status !== 403) {
    errors.push(
      buildUsageHttpErrorSnapshot({
        provider: "openrouter",
        status: keyRes.status,
      }).error ?? `HTTP ${keyRes.status}`,
    );
  }

  if (windows.length > 0) {
    return {
      provider: "openrouter",
      displayName: PROVIDER_LABELS.openrouter,
      windows,
    };
  }

  return {
    provider: "openrouter",
    displayName: PROVIDER_LABELS.openrouter,
    windows: [],
    error: errors[0] ?? "No credit data",
  };
}
