import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type Eligibility = "eligible" | "exhausted" | "cooldown" | "stale" | "reauth_required";
export type ClawRouterPoolTraffic = {
  provider?: string;
  grantLane?: string;
  grantKey?: string;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicros?: number;
};
export type ClawRouterPool = {
  version: "clawrouter.pool.v1";
  observedAt?: string;
  policyId?: string;
  routing?: {
    strategy?: string;
    includedQuotaReservePercent?: number;
    environmentFallback?: boolean;
  };
  models: string[];
  grants: Array<{
    key?: string;
    label?: string;
    provider?: string;
    kind?: string;
    enabled?: boolean;
    credentialStatus?: string;
    plan?: string;
    account?: { email?: string; rateLimitTier?: string; subscriptionStatus?: string };
    windows: Array<{
      id?: string;
      window?: string;
      models?: string[] | null;
      remainingPercent?: number;
      resetAt?: string;
      observedAt?: string;
    }>;
    extraUsage?: {
      enabled?: boolean;
      usedCredits?: number;
      monthlyLimit?: number;
      currency?: string;
      spendLimitReached?: boolean;
    };
    eligibility: Record<string, Eligibility>;
    lastSelectedAt?: string;
    selectedCount?: number;
  }>;
  usage: { days?: number; lanes: ClawRouterPoolTraffic[]; grants: ClawRouterPoolTraffic[] };
};
export type ClawRouterPoolResult =
  | { status: "ok"; pool: ClawRouterPool }
  | {
      status: "not_configured" | "hidden" | "unsupported" | "unauthorized" | "unavailable";
      message: string;
    };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 256
    ? value.trim()
    : undefined;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function date(value: unknown): string | undefined {
  const str = text(value);
  return str && Number.isFinite(Date.parse(str)) ? str : undefined;
}
function rows(value: unknown, max: number): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.slice(0, max).flatMap((row) => {
        const record = asOptionalRecord(row);
        return record ? [record] : [];
      })
    : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.slice(0, 200).flatMap((entry) => text(entry) ?? []))]
    : [];
}
function traffic(value: unknown): ClawRouterPoolTraffic[] {
  return rows(value, 400).map((row) => ({
    provider: text(row.provider),
    grantLane: text(row.grantLane),
    grantKey: text(row.grantKey),
    requests: number(row.requests),
    inputTokens: number(row.inputTokens),
    outputTokens: number(row.outputTokens),
    cacheReadTokens: number(row.cacheReadTokens),
    cacheWriteTokens: number(row.cacheWriteTokens),
    costMicros: number(row.costMicros),
  }));
}

/** Select only the public pool contract; upstream additions never leak into RPC results. */
export function parseClawRouterPool(value: unknown): ClawRouterPool | undefined {
  const root = asOptionalRecord(value);
  if (root?.version !== "clawrouter.pool.v1") {
    return undefined;
  }
  const routing = asOptionalRecord(root.routing);
  const usage = asOptionalRecord(root.usage);
  return {
    version: "clawrouter.pool.v1",
    observedAt: date(root.observedAt),
    policyId: text(root.policyId),
    routing: routing
      ? {
          strategy: text(routing.strategy),
          includedQuotaReservePercent: number(routing.includedQuotaReservePercent, 100),
          environmentFallback: bool(routing.environmentFallback),
        }
      : undefined,
    models: strings(root.models),
    grants: rows(root.grants, 200).map((grant) => {
      const account = asOptionalRecord(grant.account);
      const extra = asOptionalRecord(grant.extraUsage);
      const eligibility = asOptionalRecord(grant.eligibility);
      return {
        key: text(grant.key),
        label: text(grant.label),
        provider: text(grant.provider),
        kind: text(grant.kind),
        enabled: bool(grant.enabled),
        credentialStatus: text(grant.credentialStatus),
        plan: text(grant.plan),
        account: account
          ? {
              email: text(account.email),
              rateLimitTier: text(account.rateLimitTier),
              subscriptionStatus: text(account.subscriptionStatus),
            }
          : undefined,
        windows: rows(grant.windows, 20).map((window) => ({
          id: text(window.id),
          window: text(window.window),
          models:
            window.models === null
              ? null
              : Array.isArray(window.models)
                ? strings(window.models)
                : undefined,
          remainingPercent: number(window.remainingPercent, 100),
          resetAt: date(window.resetAt),
          observedAt: date(window.observedAt),
        })),
        extraUsage: extra
          ? {
              enabled: bool(extra.enabled),
              usedCredits: number(extra.usedCredits),
              monthlyLimit: number(extra.monthlyLimit),
              currency: text(extra.currency),
              spendLimitReached: bool(extra.spendLimitReached),
            }
          : undefined,
        eligibility: Object.fromEntries(
          Object.entries(eligibility ?? {})
            .slice(0, 200)
            .flatMap(([model, state]) =>
              text(model) &&
              (state === "eligible" ||
                state === "exhausted" ||
                state === "cooldown" ||
                state === "stale" ||
                state === "reauth_required")
                ? [[model, state]]
                : [],
            ),
        ),
        lastSelectedAt: date(grant.lastSelectedAt),
        selectedCount: number(grant.selectedCount),
      };
    }),
    usage: {
      days: number(usage?.days),
      lanes: traffic(usage?.lanes),
      grants: traffic(usage?.grants),
    },
  };
}
