import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("provider-rate-limiter");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const DEFAULT_HEADROOM = 0.85;
const MINIMAX_TEXT_RPM = 500;
const MINIMAX_TEXT_TPM = 20_000_000;

type LimitRecord = { at: number; requests: number; tokens: number };

type RateLimitReason = "rpm" | "tpm" | "weekly-requests" | "weekly-tokens" | "retry-after";

export type ProviderLimiterPolicy = {
  enabled: boolean;
  provider: string;
  model: string;
  rpm?: number;
  tpm?: number;
  headroom: number;
  weeklyEnabled: boolean;
  weeklyRequestLimit?: number;
  weeklyTokenLimit?: number;
};

export type ProviderLimiterKey = {
  provider: string;
  model: string;
  profile?: string;
  capability?: string;
};

export type ProviderLimiterDecision = {
  delayMs: number;
  reason?: RateLimitReason;
  bucketKey: string;
};

export type ParsedRateLimitHeaders = {
  retryAfterMs?: number;
  limit?: number;
  remaining?: number;
  resetAtMs?: number;
};

type BucketState = {
  minute: LimitRecord[];
  week: LimitRecord[];
  cooldownUntilMs?: number;
  learnedRpm?: number;
};

const buckets = new Map<string, BucketState>();

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return defaultValue;
  return !/^(?:0|false|off|no|disabled)$/i.test(value);
}

function readNumberEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function clampHeadroom(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HEADROOM;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_HEADROOM;
  return Math.min(1, value);
}

export function buildProviderLimiterBucketKey(key: ProviderLimiterKey): string {
  return [
    key.provider.trim().toLowerCase(),
    key.profile?.trim().toLowerCase() || "default",
    key.capability?.trim().toLowerCase() || "llm",
    key.model.trim(),
  ].join("|");
}

export function resolveProviderLimiterPolicy(params: {
  provider: string;
  model: string;
}): ProviderLimiterPolicy | undefined {
  const provider = params.provider.trim().toLowerCase();
  const model = params.model.trim();
  if (provider !== "minimax" && provider !== "minimax-portal") return undefined;
  if (!/^MiniMax-M2\.(?:7|5|1)(?:-highspeed)?$/.test(model) && model !== "MiniMax-M2") {
    return undefined;
  }

  const rpm = readNumberEnv("OPENCLAW_PROVIDER_LIMITER_MINIMAX_RPM") ?? MINIMAX_TEXT_RPM;
  const tpm = readNumberEnv("OPENCLAW_PROVIDER_LIMITER_MINIMAX_TPM") ?? MINIMAX_TEXT_TPM;
  const weeklyEnabled = readBooleanEnv("OPENCLAW_PROVIDER_LIMITER_MINIMAX_WEEKLY", true);
  const weeklyRequestLimit =
    readNumberEnv("OPENCLAW_PROVIDER_LIMITER_MINIMAX_WEEKLY_REQUESTS") ?? rpm * 60 * 5 * 10;
  const weeklyTokenLimit =
    readNumberEnv("OPENCLAW_PROVIDER_LIMITER_MINIMAX_WEEKLY_TOKENS") ?? tpm * 60 * 5 * 10;

  return {
    enabled: readBooleanEnv("OPENCLAW_PROVIDER_LIMITER_ENABLED", true),
    provider,
    model,
    rpm,
    tpm,
    headroom: clampHeadroom(readNumberEnv("OPENCLAW_PROVIDER_LIMITER_HEADROOM")),
    weeklyEnabled,
    weeklyRequestLimit,
    weeklyTokenLimit,
  };
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(trimmed);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

function parseHeaderNumber(headers: Headers, names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (!raw) continue;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function parseProviderRateLimitHeaders(
  headers: Headers,
  nowMs = Date.now(),
): ParsedRateLimitHeaders {
  const resetSeconds = parseHeaderNumber(headers, [
    "x-ratelimit-reset",
    "x-rate-limit-reset",
    "ratelimit-reset",
  ]);
  const resetAtMs =
    resetSeconds === undefined
      ? undefined
      : resetSeconds > 10_000_000_000
        ? resetSeconds
        : resetSeconds > 10_000_000
          ? resetSeconds * 1000
          : nowMs + resetSeconds * 1000;
  return {
    retryAfterMs:
      parseRetryAfterMs(headers.get("retry-after-ms"), nowMs) ??
      parseRetryAfterMs(headers.get("retry-after"), nowMs),
    limit: parseHeaderNumber(headers, [
      "x-ratelimit-limit",
      "x-rate-limit-limit",
      "ratelimit-limit",
    ]),
    remaining: parseHeaderNumber(headers, [
      "x-ratelimit-remaining",
      "x-rate-limit-remaining",
      "ratelimit-remaining",
    ]),
    resetAtMs,
  };
}

function prune(records: LimitRecord[], nowMs: number, windowMs: number): void {
  while (records.length > 0 && records[0]!.at <= nowMs - windowMs) records.shift();
}

function usage(records: LimitRecord[]): { requests: number; tokens: number } {
  return records.reduce(
    (acc, record) => ({
      requests: acc.requests + record.requests,
      tokens: acc.tokens + record.tokens,
    }),
    { requests: 0, tokens: 0 },
  );
}

function delayUntilBudget(params: {
  records: LimitRecord[];
  nowMs: number;
  windowMs: number;
  current: number;
  cost: number;
  limit: number | undefined;
  read: (record: LimitRecord) => number;
}): number {
  if (!params.limit || params.limit <= 0 || params.current + params.cost <= params.limit) return 0;
  let overflow = params.current + params.cost - params.limit;
  for (const record of params.records) {
    overflow -= params.read(record);
    if (overflow <= 0) return Math.max(0, record.at + params.windowMs - params.nowMs);
  }
  return params.windowMs;
}

export function estimateProviderRequestTokens(body: unknown): number {
  if (typeof body !== "string") return 1;
  const trimmed = body.trim();
  if (!trimmed) return 1;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const text = JSON.stringify(parsed);
    return Math.max(1, Math.ceil(text.length / 4));
  } catch {
    return Math.max(1, Math.ceil(trimmed.length / 4));
  }
}

export function reserveProviderLimiterSlot(params: {
  key: ProviderLimiterKey;
  policy: ProviderLimiterPolicy;
  tokens: number;
  nowMs?: number;
}): ProviderLimiterDecision {
  const nowMs = params.nowMs ?? Date.now();
  const bucketKey = buildProviderLimiterBucketKey(params.key);
  const state = buckets.get(bucketKey) ?? { minute: [], week: [] };
  buckets.set(bucketKey, state);
  prune(state.minute, nowMs, MINUTE_MS);
  prune(state.week, nowMs, WEEK_MS);

  const effectiveRpm = (state.learnedRpm ?? params.policy.rpm ?? 0) * params.policy.headroom;
  const effectiveTpm = (params.policy.tpm ?? 0) * params.policy.headroom;
  const effectiveWeeklyRequests = params.policy.weeklyEnabled
    ? (params.policy.weeklyRequestLimit ?? 0) * params.policy.headroom
    : undefined;
  const effectiveWeeklyTokens = params.policy.weeklyEnabled
    ? (params.policy.weeklyTokenLimit ?? 0) * params.policy.headroom
    : undefined;

  const minuteUsage = usage(state.minute);
  const weekUsage = usage(state.week);
  const cooldownDelay = state.cooldownUntilMs ? Math.max(0, state.cooldownUntilMs - nowMs) : 0;
  const candidates: Array<{ delayMs: number; reason: RateLimitReason }> = [
    { delayMs: cooldownDelay, reason: "retry-after" },
    {
      delayMs: delayUntilBudget({
        records: state.minute,
        nowMs,
        windowMs: MINUTE_MS,
        current: minuteUsage.requests,
        cost: 1,
        limit: effectiveRpm,
        read: (record) => record.requests,
      }),
      reason: "rpm",
    },
    {
      delayMs: delayUntilBudget({
        records: state.minute,
        nowMs,
        windowMs: MINUTE_MS,
        current: minuteUsage.tokens,
        cost: params.tokens,
        limit: effectiveTpm,
        read: (record) => record.tokens,
      }),
      reason: "tpm",
    },
    {
      delayMs: delayUntilBudget({
        records: state.week,
        nowMs,
        windowMs: WEEK_MS,
        current: weekUsage.requests,
        cost: 1,
        limit: effectiveWeeklyRequests,
        read: (record) => record.requests,
      }),
      reason: "weekly-requests",
    },
    {
      delayMs: delayUntilBudget({
        records: state.week,
        nowMs,
        windowMs: WEEK_MS,
        current: weekUsage.tokens,
        cost: params.tokens,
        limit: effectiveWeeklyTokens,
        read: (record) => record.tokens,
      }),
      reason: "weekly-tokens",
    },
  ];
  const selected = candidates.reduce((best, candidate) =>
    candidate.delayMs > best.delayMs ? candidate : best,
  );
  const reserveAt = nowMs + selected.delayMs;
  state.minute.push({ at: reserveAt, requests: 1, tokens: params.tokens });
  state.week.push({ at: reserveAt, requests: 1, tokens: params.tokens });
  return {
    bucketKey,
    delayMs: selected.delayMs,
    ...(selected.delayMs > 0 ? { reason: selected.reason } : {}),
  };
}

export function observeProviderLimiterResponse(params: {
  key: ProviderLimiterKey;
  policy: ProviderLimiterPolicy;
  status: number;
  headers: Headers;
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  const bucketKey = buildProviderLimiterBucketKey(params.key);
  const state = buckets.get(bucketKey) ?? { minute: [], week: [] };
  buckets.set(bucketKey, state);
  const parsed = parseProviderRateLimitHeaders(params.headers, nowMs);
  if (parsed.limit !== undefined && parsed.limit > 0) state.learnedRpm = parsed.limit;
  if (params.status === 429 && parsed.retryAfterMs !== undefined) {
    state.cooldownUntilMs = Math.max(state.cooldownUntilMs ?? 0, nowMs + parsed.retryAfterMs);
  }
  if (parsed.remaining === 0 && parsed.resetAtMs !== undefined) {
    state.cooldownUntilMs = Math.max(state.cooldownUntilMs ?? 0, parsed.resetAtMs);
  }
}

export async function waitForProviderLimiter(params: {
  key: ProviderLimiterKey;
  policy: ProviderLimiterPolicy;
  tokens: number;
  signal?: AbortSignal | null;
}): Promise<ProviderLimiterDecision> {
  if (!params.policy.enabled) {
    return { delayMs: 0, bucketKey: buildProviderLimiterBucketKey(params.key) };
  }
  const decision = reserveProviderLimiterSlot(params);
  if (decision.delayMs <= 0) return decision;
  log.info(
    `[provider-limiter] delaying provider=${params.key.provider} model=${params.key.model} ` +
      `bucket=${decision.bucketKey} delayMs=${Math.ceil(decision.delayMs)} reason=${decision.reason}`,
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, decision.delayMs);
    if (params.signal) {
      const abort = () => {
        clearTimeout(timeout);
        reject(params.signal?.reason ?? new Error("Provider rate limiter wait aborted"));
      };
      if (params.signal.aborted) abort();
      else params.signal.addEventListener("abort", abort, { once: true });
    }
  });
  return decision;
}

export function resetProviderLimiterForTests(): void {
  buckets.clear();
}
