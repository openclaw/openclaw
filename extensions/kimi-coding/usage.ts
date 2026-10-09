import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
// Kimi Coding usage fetcher for coding-plan quota windows.
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type KimiUsageRow = {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
};

type KimiUsageLimit = KimiUsageRow & {
  name?: unknown;
  title?: unknown;
  scope?: unknown;
  duration?: unknown;
  timeUnit?: unknown;
  detail?: KimiUsageRow & {
    name?: unknown;
    title?: unknown;
    scope?: unknown;
    duration?: unknown;
    timeUnit?: unknown;
  };
  window?: {
    duration?: unknown;
    timeUnit?: unknown;
  };
};

type KimiUsageResponse = {
  usage?: KimiUsageRow;
  limits?: KimiUsageLimit[];
};

const DEFAULT_KIMI_USAGE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_MANAGED_USAGE_ORIGINS = new Set(["https://api.kimi.com", "https://api.kimi.ai"]);
const KIMI_MANAGED_USAGE_PATHS = new Set(["/coding", "/coding/v1"]);

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function usagePercent(row: unknown): number | undefined {
  const record = isRecord(row) ? row : undefined;
  if (!record) {
    return undefined;
  }
  const limit = toNumber(record.limit);
  let used = toNumber(record.used);
  const remaining = toNumber(record.remaining);
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = Math.max(0, limit - remaining);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return Math.round(clampPercent((used / limit) * 100) * 100) / 100;
}

function isFiveHourLimit(item: KimiUsageLimit): boolean {
  const detail = isRecord(item.detail) ? item.detail : {};
  const window = isRecord(item.window) ? item.window : {};
  const label = [item.name, item.title, item.scope, detail.name, detail.title, detail.scope]
    .map((value) => toText(value)?.toLowerCase())
    .filter((value) => value !== undefined)
    .join(" ");
  if (label.includes("5h") || label.includes("5 hour") || label.includes("5-hour")) {
    return true;
  }

  const duration = toNumber(window.duration ?? item.duration ?? detail.duration);
  const timeUnit = toText(window.timeUnit ?? item.timeUnit ?? detail.timeUnit)?.toUpperCase() ?? "";
  return (
    (duration === 300 && timeUnit.includes("MINUTE")) ||
    (duration === 5 && timeUnit.includes("HOUR"))
  );
}

function parseKimiUsageWindows(payload: unknown): UsageWindow[] {
  // SAFETY: isRecord establishes the response object's string-keyed shape before field access.
  const data = isRecord(payload) ? (payload as KimiUsageResponse) : undefined;
  if (!data) {
    return [];
  }

  // The managed endpoint now reports ratios; older API-key responses used
  // absolute usage/limits rows. Keep both observed endpoint contracts bounded.
  if (isRecord(payload) && isRecord(payload.usages)) {
    const usages = payload.usages;
    return (["5h", "7d"] as const).flatMap((label) => {
      const row = usages[`limit_${label}`];
      if (!isRecord(row)) {
        return [];
      }
      const ratio = toNumber(row.used_ratio);
      if (ratio === undefined) {
        return [];
      }
      const resetAt = typeof row.reset_time === "string" ? Date.parse(row.reset_time) : Number.NaN;
      return [
        {
          label,
          usedPercent: Math.round(clampPercent(ratio * 100) * 100) / 100,
          ...(Number.isFinite(resetAt) ? { resetAt } : {}),
        },
      ];
    });
  }

  const windows: UsageWindow[] = [];
  const sevenDay = usagePercent(data.usage);
  if (sevenDay !== undefined) {
    windows.push({ label: "7d", usedPercent: sevenDay });
  }

  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    if (!isRecord(item) || !isFiveHourLimit(item)) {
      continue;
    }
    const row = isRecord(item.detail) ? item.detail : item;
    const fiveHour = usagePercent(row);
    if (fiveHour !== undefined) {
      windows.unshift({ label: "5h", usedPercent: fiveHour });
      break;
    }
  }

  return windows;
}

export async function fetchKimiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: { baseUrl?: string },
): Promise<ProviderUsageSnapshot> {
  const baseUrl = resolveManagedKimiUsageBaseUrl([normalizeKimiUsageBaseUrl(options?.baseUrl)]);
  if (!baseUrl) {
    return buildUsageErrorSnapshot("kimi", "Unsupported usage endpoint");
  }
  const res = await fetchJson(
    `${baseUrl}/usages`,
    {
      method: "GET",
      // A managed endpoint must never forward its bearer to a redirect destination.
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: "kimi",
      status: res.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  let payload: unknown;
  try {
    payload = await readProviderJsonResponse<unknown>(res, "kimi usage");
  } catch {
    return buildUsageErrorSnapshot("kimi", "Malformed usage response");
  }

  const windows = parseKimiUsageWindows(payload);
  if (windows.length === 0) {
    return buildUsageErrorSnapshot("kimi", "Malformed usage response");
  }
  return {
    provider: "kimi",
    displayName: PROVIDER_LABELS.kimi,
    windows,
  };
}

export function normalizeKimiUsageBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || DEFAULT_KIMI_USAGE_BASE_URL).trim().replace(/\/+$/, "");
  if (!raw) {
    return DEFAULT_KIMI_USAGE_BASE_URL;
  }
  if (raw.endsWith("/coding")) {
    return `${raw}/v1`;
  }
  return raw;
}

export function isManagedKimiUsageBaseUrl(baseUrl?: string): boolean {
  try {
    const url = new URL(normalizeKimiUsageBaseUrl(baseUrl));
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return (
      KIMI_MANAGED_USAGE_ORIGINS.has(url.origin) &&
      KIMI_MANAGED_USAGE_PATHS.has(pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Provider-level credentials are safe only when every effective model shares one managed route. */
export function resolveManagedKimiUsageBaseUrl(baseUrls?: readonly string[]): string | undefined {
  if (
    !baseUrls?.length ||
    baseUrls.some((baseUrl) => !baseUrl.trim() || !isManagedKimiUsageBaseUrl(baseUrl))
  ) {
    return undefined;
  }
  const normalized = new Set(
    baseUrls.map((baseUrl) => new URL(normalizeKimiUsageBaseUrl(baseUrl)).href.replace(/\/+$/, "")),
  );
  return normalized.size === 1 ? normalized.values().next().value : undefined;
}
