// xAI plugin module implements SuperGrok provider usage behavior.
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  type ProviderUsageBilling,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const XAI_PROVIDER_ID = "xai";
const SUPERGROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUPERGROK_CLIENT_MODE = "cli";
const SUPERGROK_CLIENT_VERSION = "1.0.4";
const MAX_PLAN_CHARS = 128;
const MAX_EXACT_INTEGER = 9_007_199_254_740_991;

type BillingConfig = Record<string, unknown>;

function parseCentValue(value: unknown): number | undefined {
  const raw = asOptionalRecord(value)?.val;
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return undefined;
}

function parseMoneyValue(value: unknown): number | undefined {
  const cents = parseCentValue(value);
  if (cents === undefined || cents < 0 || cents > MAX_EXACT_INTEGER) {
    return undefined;
  }
  return cents / 100;
}

function parsePlan(value: unknown): string | undefined {
  const plan = normalizeOptionalString(value);
  if (!plan || plan.length > MAX_PLAN_CHARS || hasControlCharacter(plan)) {
    return undefined;
  }
  return plan;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) {
      return true;
    }
  }
  return false;
}

function parsePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return clampPercent(value);
}

function readCurrentPeriod(config: BillingConfig) {
  return asOptionalRecord(config["currentPeriod"] ?? config["current_period"]);
}

function readPeriodType(currentPeriod: Record<string, unknown> | undefined): string {
  return normalizeOptionalString(currentPeriod?.type) ?? "";
}

function readPeriodBoundMs(
  config: BillingConfig,
  currentPeriod: Record<string, unknown> | undefined,
  bound: "start" | "end",
): number | undefined {
  const periodKey = bound === "start" ? "start" : "end";
  const billingKey = bound === "start" ? "billingPeriodStart" : "billingPeriodEnd";
  const billingSnakeKey = bound === "start" ? "billing_period_start" : "billing_period_end";
  return parseDateStringTimestampMs(
    currentPeriod?.[periodKey] ?? config[billingKey] ?? config[billingSnakeKey],
  );
}

function hasRecognizedUsagePeriod(config: BillingConfig): boolean {
  const currentPeriod = readCurrentPeriod(config);
  const periodType = readPeriodType(currentPeriod);
  if (!periodType.endsWith("WEEKLY") && !periodType.endsWith("MONTHLY")) {
    return false;
  }
  return (
    readPeriodBoundMs(config, currentPeriod, "start") !== undefined ||
    readPeriodBoundMs(config, currentPeriod, "end") !== undefined
  );
}

function hasIncludedUsagePercentField(config: BillingConfig): boolean {
  return (config["creditUsagePercent"] ?? config["credit_usage_percent"]) !== undefined;
}

function resolveUsageWindow(config: BillingConfig): UsageWindow | undefined {
  const currentPeriod = readCurrentPeriod(config);
  const explicitPercent = parsePercent(
    config["creditUsagePercent"] ?? config["credit_usage_percent"],
  );
  const used = parseCentValue(config["used"]);
  const monthlyLimit = parseCentValue(config["monthlyLimit"] ?? config["monthly_limit"]);
  const legacyPercent =
    used !== undefined && monthlyLimit !== undefined && monthlyLimit > 0 && used >= 0
      ? parsePercent((used / monthlyLimit) * 100)
      : undefined;
  const percent = explicitPercent ?? legacyPercent;
  if (percent === undefined) {
    return undefined;
  }

  const periodType = readPeriodType(currentPeriod);
  const label = periodType.endsWith("WEEKLY")
    ? "Weekly"
    : periodType.endsWith("MONTHLY") ||
        monthlyLimit !== undefined ||
        config["billingPeriodEnd"] !== undefined ||
        config["billing_period_end"] !== undefined
      ? "Monthly"
      : "Usage";
  const resetAt = readPeriodBoundMs(config, currentPeriod, "end");
  return {
    label,
    usedPercent: percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function resolveBilling(config: BillingConfig): ProviderUsageBilling[] | undefined {
  const prepaid = parseMoneyValue(config["prepaidBalance"] ?? config["prepaid_balance"]);
  if (prepaid === undefined) {
    return undefined;
  }
  return [
    {
      type: "balance",
      label: "Prepaid balance",
      amount: prepaid,
      unit: "USD",
    },
  ];
}

function buildSuperGrokUsageSnapshot(data: unknown): ProviderUsageSnapshot {
  const payload = asOptionalRecord(data);
  const config = asOptionalRecord(payload?.["config"]);
  if (!config) {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      error: "Malformed billing response",
    };
  }

  const window = resolveUsageWindow(config);
  const billing = resolveBilling(config);
  const plan =
    parsePlan(payload?.["subscription_tier"] ?? payload?.["subscriptionTier"]) ?? "SuperGrok";
  if (window) {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [window],
      billing,
      plan,
    };
  }

  // xAI omits default-zero included-usage scalars on valid weekly/monthly
  // billing responses. Do not invent a percent, and do not read on-demand
  // pay-as-you-go counters as SuperGrok subscription quota.
  if (!hasIncludedUsagePercentField(config) && hasRecognizedUsagePeriod(config)) {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      billing,
      plan,
      summary: "Included usage omitted",
    };
  }

  return {
    provider: XAI_PROVIDER_ID,
    displayName: "SuperGrok",
    windows: [],
    error: "No usage data",
  };
}

export async function fetchXaiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const response = await fetchJson(
    SUPERGROK_BILLING_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-grok-client-mode": SUPERGROK_CLIENT_MODE,
        "x-grok-client-version": SUPERGROK_CLIENT_VERSION,
      },
    },
    timeoutMs,
    fetchFn,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: XAI_PROVIDER_ID,
      status: response.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  try {
    return buildSuperGrokUsageSnapshot(
      await readProviderJsonResponse<unknown>(response, "xai-usage"),
    );
  } catch {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      error: "Malformed billing response",
    };
  }
}
