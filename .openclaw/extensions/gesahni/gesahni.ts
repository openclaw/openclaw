import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolContext } from "../../../src/plugins/types.js";

const DEFAULT_TIMEOUT_MS = 2_500;
export const RETRY_DELAYS_MS = [300, 600];

export const GesahniReadSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniEarningsSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    days: Type.Optional(Type.Number({ minimum: 1, maximum: 180 })),
    symbols: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniIdSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniAlertDeliveriesSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    alert_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniSymbolSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniSymbolsBatchSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    symbols: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

const AlertDirectionSchema = Type.String({ pattern: "^(above|below)$" });

export const GesahniWatchlistWriteSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniAlertCreateSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    direction: Type.Optional(AlertDirectionSchema),
    threshold: Type.Optional(Type.Number({ minimum: 0 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false },
);

export const GesahniAlertUpdateSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    alert_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    threshold: Type.Optional(Type.Number({ minimum: 0 })),
    enabled: Type.Optional(Type.Boolean()),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false },
);

export const GesahniAlertDeleteSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    alert_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const OptionsWatchRuleDirectionSchema = Type.String({ pattern: "^(above|below)$" });

export const GesahniOptionsWatchRuleCreateSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    contract_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    direction: Type.Optional(OptionsWatchRuleDirectionSchema),
    threshold_value: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    enabled: Type.Optional(Type.Boolean()),
    cooldown_minutes: Type.Optional(Type.Number({ minimum: 0, maximum: 10_080 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false },
);

export const GesahniOptionsWatchRuleUpdateSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    rule_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    direction: Type.Optional(OptionsWatchRuleDirectionSchema),
    threshold_value: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    enabled: Type.Optional(Type.Boolean()),
    cooldown_minutes: Type.Optional(Type.Number({ minimum: 0, maximum: 10_080 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  },
  { additionalProperties: false },
);

export const GesahniOptionsWatchRuleDeleteSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    rule_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniOptionsSuggestionApplySchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    suggestion_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniOptionsSuggestionsApplyAllSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export const GesahniWriteConfirmSchema = Type.Object(
  {
    user_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    pending_action_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    command: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export type GesahniReadParams = Static<typeof GesahniReadSchema>;
export type GesahniEarningsParams = Static<typeof GesahniEarningsSchema>;
export type GesahniIdParams = Static<typeof GesahniIdSchema>;
export type GesahniAlertDeliveriesParams = Static<typeof GesahniAlertDeliveriesSchema>;
export type GesahniSymbolParams = Static<typeof GesahniSymbolSchema>;
export type GesahniSymbolsBatchParams = Static<typeof GesahniSymbolsBatchSchema>;
export type GesahniWatchlistWriteParams = Static<typeof GesahniWatchlistWriteSchema>;
export type GesahniAlertCreateParams = Static<typeof GesahniAlertCreateSchema>;
export type GesahniAlertUpdateParams = Static<typeof GesahniAlertUpdateSchema>;
export type GesahniAlertDeleteParams = Static<typeof GesahniAlertDeleteSchema>;
export type GesahniOptionsWatchRuleCreateParams = Static<
  typeof GesahniOptionsWatchRuleCreateSchema
>;
export type GesahniOptionsWatchRuleUpdateParams = Static<
  typeof GesahniOptionsWatchRuleUpdateSchema
>;
export type GesahniOptionsWatchRuleDeleteParams = Static<
  typeof GesahniOptionsWatchRuleDeleteSchema
>;
export type GesahniOptionsSuggestionApplyParams = Static<
  typeof GesahniOptionsSuggestionApplySchema
>;
export type GesahniOptionsSuggestionsApplyAllParams = Static<
  typeof GesahniOptionsSuggestionsApplyAllSchema
>;
export type GesahniWriteConfirmParams = Static<typeof GesahniWriteConfirmSchema>;

export type GesahniPluginConfig = {
  baseUrl: string;
  readBridgeToken: string;
  writeBridgeToken: string;
  defaultTimeoutMs: number;
};

type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;

type BridgeRequestOptions = {
  path: string;
  userId: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  auth: "read" | "write";
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
};

type GuardedCacheEntry = {
  expiresAt: number;
  payload?: Record<string, unknown>;
  inFlight?: Promise<Record<string, unknown>>;
};

const CHAIN_CACHE_TTL_MS = 30_000;
const QUOTES_CACHE_TTL_MS = 10_000;
const GUARD_RATE_WINDOW_MS = 60_000;
const CHAIN_RATE_LIMIT_MAX = 4;
const QUOTES_RATE_LIMIT_MAX = 6;
const PENDING_WRITE_TTL_MS = 5 * 60_000;
const QUOTES_BATCH_MAX_SYMBOLS = 20;
const GUARDED_CACHE_MAX_ENTRIES = 200;
const WATCH_RULE_EVENTS_PATH_PATTERN = /^\/v1\/bridge\/options\/watch_rules\/[^/]+\/events$/;
const ALERT_DELIVERIES_PATH_PATTERN = /^\/v1\/bridge\/alerts\/[^/]+\/deliveries$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GesahniAlertDirection = "above" | "below";
type GesahniOptionsWatchRuleDirection = "above" | "below";
type PendingWriteKind =
  | "watchlist_add"
  | "watchlist_remove"
  | "alert_create"
  | "alert_update"
  | "alert_delete"
  | "options_watch_rule_create"
  | "options_watch_rule_update"
  | "options_watch_rule_delete"
  | "options_alert_suggestion_apply"
  | "options_alert_suggestions_apply_all";

type PendingWriteAction = {
  id: string;
  kind: PendingWriteKind;
  userId: string;
  scopeKey: string;
  idempotencyKey: string;
  endpoint: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  summary: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "executing";
};

const chainSnapshotCache = new Map<string, GuardedCacheEntry>();
const quotesBatchCache = new Map<string, GuardedCacheEntry>();
const guardedRequestWindows = new Map<string, number[]>();
const pendingWriteActions = new Map<string, PendingWriteAction>();

function toTextContent(text: string) {
  return [
    {
      type: "text" as const,
      text,
    },
  ];
}

function asToolResponse(payload: unknown, text?: string) {
  const body = text ?? JSON.stringify(payload, null, 2);
  return {
    content: toTextContent(body),
    details: payload,
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeTimeout(value: unknown): number {
  const candidate = normalizeNumber(value) ?? DEFAULT_TIMEOUT_MS;
  return Math.max(500, Math.min(10_000, Math.trunc(candidate)));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function formatBridgeEndpointFailure(path: string, status: number, detail?: string): string {
  const base = `bridge endpoint ${path} failed (${status})`;
  const normalizedDetail = normalizeString(detail);
  if (!normalizedDetail) {
    return base;
  }
  return `${base}: ${normalizedDetail}`;
}

function formatBridgeErrorJson(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const obj = payload as Record<string, unknown>;
  const detailCandidates = [
    normalizeString(obj.error),
    normalizeString(obj.detail),
    normalizeString(obj.message),
    normalizeString(obj.reason),
  ].filter((value): value is string => Boolean(value));
  if (detailCandidates.length === 0) {
    return undefined;
  }
  const deduped: string[] = [];
  for (const candidate of detailCandidates) {
    if (!deduped.includes(candidate)) {
      deduped.push(candidate);
    }
  }
  return deduped.join(": ");
}

async function parseBridgeErrorDetail(response: Response): Promise<string | undefined> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const payload = await response.clone().json();
      const detailFromJson = formatBridgeErrorJson(payload);
      if (detailFromJson) {
        return detailFromJson;
      }
    } catch {
      // Ignore JSON parse errors and fall through to text fallback.
    }
  }
  try {
    const body = normalizeString(await response.clone().text());
    if (body) {
      return body;
    }
  } catch {
    // Keep endpoint+status fallback when body cannot be read.
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = String((error as { name?: unknown }).name || "");
  return name.toLowerCase() === "aborterror";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildBridgeUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
) {
  const url = new URL(path, `${trimTrailingSlash(baseUrl)}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function parseSymbols(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const symbols = raw
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    return undefined;
  }
  return symbols.join(",");
}

function parseCommandTokens(raw: unknown): string[] {
  const command = normalizeString(raw);
  if (!command) {
    return [];
  }
  return command.split(/\s+/).filter(Boolean);
}

function normalizeSymbol(value: unknown): string | undefined {
  const normalized = normalizeString(value)?.toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Z0-9._-]{1,15}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeLookupId(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeUuid(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}

function requireSingleCommandToken(rawCommand: unknown, fieldName: string): string {
  const tokens = parseCommandTokens(rawCommand);
  if (tokens.length !== 1) {
    throw new Error(`${fieldName} is required`);
  }
  return tokens[0]!;
}

function resolveLookupId(rawValue: unknown, rawCommand: unknown, fieldName: string): string {
  const direct = normalizeLookupId(rawValue);
  if (direct) {
    return direct;
  }
  const fromCommand = normalizeLookupId(requireSingleCommandToken(rawCommand, fieldName));
  if (!fromCommand) {
    throw new Error(`${fieldName} is required`);
  }
  return fromCommand;
}

function resolveSymbol(rawValue: unknown, rawCommand: unknown): string {
  const direct = normalizeSymbol(rawValue);
  if (direct) {
    return direct;
  }
  const fromCommand = normalizeSymbol(requireSingleCommandToken(rawCommand, "symbol"));
  if (!fromCommand) {
    throw new Error("symbol is required");
  }
  return fromCommand;
}

function parseSymbolsList(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(/[,\s]+/)
    .map((entry) => normalizeSymbol(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveSymbolsBatch(rawValue: unknown, rawCommand: unknown): string {
  const direct = parseSymbolsList(typeof rawValue === "string" ? rawValue : "");
  const fromCommand = parseSymbolsList(typeof rawCommand === "string" ? rawCommand : "");
  const symbols = direct.length > 0 ? direct : fromCommand;
  if (symbols.length === 0) {
    throw new Error("symbols are required");
  }
  if (symbols.length > QUOTES_BATCH_MAX_SYMBOLS) {
    throw new Error(
      `quotes_batch supports at most ${QUOTES_BATCH_MAX_SYMBOLS} symbols per request; try again with fewer symbols`,
    );
  }
  return Array.from(new Set(symbols)).join(",");
}

function idLookupFailureMessage(path: string, status: number): string | undefined {
  if (status !== 404 && status !== 422 && status < 500) {
    return undefined;
  }
  if (WATCH_RULE_EVENTS_PATH_PATTERN.test(path)) {
    return "watch rule id was not found";
  }
  if (ALERT_DELIVERIES_PATH_PATTERN.test(path)) {
    return "alert id was not found";
  }
  return undefined;
}

function pruneGuardedCache(map: Map<string, GuardedCacheEntry>) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (!entry.inFlight && entry.expiresAt <= now) {
      map.delete(key);
    }
  }
  while (map.size > GUARDED_CACHE_MAX_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (!firstKey) {
      break;
    }
    map.delete(firstKey);
  }
}

function consumeGuardedBudget(params: {
  key: string;
  limit: number;
  windowMs: number;
}): number | null {
  const now = Date.now();
  const recent = (guardedRequestWindows.get(params.key) ?? []).filter(
    (value) => now - value < params.windowMs,
  );
  if (recent.length >= params.limit) {
    const retryAfterMs = params.windowMs - (now - recent[0]!);
    guardedRequestWindows.set(params.key, recent);
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
  recent.push(now);
  guardedRequestWindows.set(params.key, recent);
  return null;
}

async function readGuardedCachedBridge(params: {
  cache: Map<string, GuardedCacheEntry>;
  cacheKey: string;
  cacheTtlMs: number;
  limiterKey: string;
  limit: number;
  label: string;
  fetcher: () => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  pruneGuardedCache(params.cache);
  const now = Date.now();
  const cached = params.cache.get(params.cacheKey);
  if (cached?.payload && cached.expiresAt > now) {
    return cached.payload;
  }
  if (cached?.inFlight) {
    return await cached.inFlight;
  }

  const retryAfterSeconds = consumeGuardedBudget({
    key: params.limiterKey,
    limit: params.limit,
    windowMs: GUARD_RATE_WINDOW_MS,
  });
  if (retryAfterSeconds !== null) {
    throw new Error(`${params.label} is temporarily busy; try again in ${retryAfterSeconds}s`);
  }

  const inFlight = params
    .fetcher()
    .then((payload) => {
      params.cache.set(params.cacheKey, {
        payload,
        expiresAt: Date.now() + params.cacheTtlMs,
      });
      pruneGuardedCache(params.cache);
      return payload;
    })
    .catch((error) => {
      params.cache.delete(params.cacheKey);
      throw error;
    });

  params.cache.set(params.cacheKey, {
    expiresAt: now + params.cacheTtlMs,
    inFlight,
  });
  return await inFlight;
}

function prunePendingWriteActions(now = Date.now()) {
  for (const [scopeKey, pending] of pendingWriteActions) {
    if (pending.expiresAt <= now) {
      pendingWriteActions.delete(scopeKey);
    }
  }
}

export function resetGesahniGuardrailsForTests() {
  chainSnapshotCache.clear();
  quotesBatchCache.clear();
  guardedRequestWindows.clear();
  pendingWriteActions.clear();
}

function resolveGesahniUserIdFromToolContext(
  ctx: OpenClawPluginToolContext | undefined,
): string | undefined {
  const trustedTargetUserId = normalizeGesahniUserId(ctx?.trustedTargetUserId);
  if (trustedTargetUserId) {
    return trustedTargetUserId;
  }
  if (ctx?.messageChannel !== "telegram") {
    return undefined;
  }
  const to = normalizeString(ctx.agentTo);
  const toMatch = to?.match(/^telegram:(\d+)$/);
  if (toMatch?.[1]) {
    return `tg:${toMatch[1]}`;
  }
  const senderId = normalizeString(ctx.requesterSenderId);
  if (senderId && /^\d+$/.test(senderId)) {
    return `tg:${senderId}`;
  }
  return undefined;
}

function resolveGesahniScopeContext(ctx: OpenClawPluginToolContext | undefined): {
  chatScope: string;
  sessionScope: string;
} {
  const chatScope = normalizeString(ctx?.agentTo) ?? "chat:unknown";
  const sessionScope =
    normalizeString(ctx?.sessionId) ?? normalizeString(ctx?.sessionKey) ?? "session:unknown";
  return {
    chatScope,
    sessionScope,
  };
}

function buildPendingScopeKey(params: {
  userId: string;
  chatScope: string;
  sessionScope: string;
}): string {
  return `${params.userId}::${params.chatScope}::${params.sessionScope}`;
}

function normalizeGesahniUserId(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (/^tg:\d+$/.test(normalized)) {
    return normalized;
  }
  if (/^\d+$/.test(normalized)) {
    return `tg:${normalized}`;
  }
  return undefined;
}

function resolveEffectiveGesahniUserId(rawUserId: unknown, trustedUserId?: string): string {
  const suppliedUserId = normalizeGesahniUserId(rawUserId);
  if (trustedUserId) {
    if (suppliedUserId && suppliedUserId !== trustedUserId) {
      throw new Error("user_id does not match trusted runtime identity");
    }
    return trustedUserId;
  }
  if (suppliedUserId) {
    throw new Error("explicit user_id is not allowed without trusted server-side binding");
  }
  throw new Error("user_id is required");
}

function resolveReadParams(raw: GesahniReadParams, fallbackUserId?: string): { userId: string } {
  return { userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId) };
}

function resolveEarningsParams(raw: GesahniEarningsParams): {
  userId: string;
  days: number;
  symbols?: string;
};
function resolveEarningsParams(
  raw: GesahniEarningsParams,
  fallbackUserId: string | undefined,
): {
  userId: string;
  days: number;
  symbols?: string;
};
function resolveEarningsParams(
  raw: GesahniEarningsParams,
  fallbackUserId?: string,
): {
  userId: string;
  days: number;
  symbols?: string;
} {
  const userId = resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId);
  const command = normalizeString(raw.command);
  const commandParts = command ? command.split(/\s+/).filter(Boolean) : [];

  const commandDays = commandParts.length > 0 ? normalizeNumber(commandParts[0]) : undefined;
  const days = Math.max(
    1,
    Math.min(180, Math.trunc(normalizeNumber(raw.days) ?? commandDays ?? 14)),
  );

  let symbols = parseSymbols(normalizeString(raw.symbols));
  if (!symbols && commandParts.length > 1) {
    symbols = parseSymbols(commandParts.slice(1).join(","));
  }

  return { userId, days, symbols };
}

function resolveIdParams(
  raw: GesahniIdParams,
  fallbackUserId?: string,
): {
  userId: string;
  id: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    id: resolveLookupId(raw.id, raw.command, "id"),
  };
}

function resolveAlertDeliveriesParams(
  raw: GesahniAlertDeliveriesParams,
  fallbackUserId?: string,
): {
  userId: string;
  alertId: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    alertId: resolveLookupId(raw.alert_id, raw.command, "alert_id"),
  };
}

function resolveSymbolParams(
  raw: GesahniSymbolParams,
  fallbackUserId?: string,
): {
  userId: string;
  symbol: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    symbol: resolveSymbol(raw.symbol, raw.command),
  };
}

function resolveSymbolsBatchParams(
  raw: GesahniSymbolsBatchParams,
  fallbackUserId?: string,
): {
  userId: string;
  symbols: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    symbols: resolveSymbolsBatch(raw.symbols, raw.command),
  };
}

function normalizeAlertDirection(value: unknown): GesahniAlertDirection | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "above" || normalized === "below") {
    return normalized;
  }
  return undefined;
}

function normalizeThreshold(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(/^\$/, ""));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeEnabledFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function formatThreshold(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function parseAlertCreateCommand(rawCommand: unknown): {
  symbol: string;
  direction: GesahniAlertDirection;
  threshold: number;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }
  const matched = command.match(
    /^([A-Za-z0-9._-]{1,15})\s+(above|below)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (!matched) {
    return null;
  }
  const symbol = normalizeSymbol(matched[1]);
  const direction = normalizeAlertDirection(matched[2]);
  const threshold = normalizeThreshold(matched[3]);
  if (!symbol || !direction || threshold === undefined) {
    return null;
  }
  return { symbol, direction, threshold };
}

function parseAlertUpdateCommand(rawCommand: unknown): {
  alertRef: string;
  threshold?: number;
  enabled?: boolean;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }
  const thresholdMatch = command.match(/^([A-Za-z0-9:._-]{1,120})\s+\$?([0-9]+(?:\.[0-9]+)?)$/i);
  if (thresholdMatch) {
    const alertRef = normalizeString(thresholdMatch[1]);
    const threshold = normalizeThreshold(thresholdMatch[2]);
    if (!alertRef || threshold === undefined) {
      return null;
    }
    return { alertRef, threshold };
  }

  const enabledMatch = command.match(
    /^([A-Za-z0-9:._-]{1,120})\s+enabled\s+(true|false|1|0|yes|no|on|off)$/i,
  );
  if (enabledMatch) {
    const alertRef = normalizeString(enabledMatch[1]);
    const enabled = normalizeEnabledFlag(enabledMatch[2]);
    if (!alertRef || enabled === undefined) {
      return null;
    }
    return { alertRef, enabled };
  }
  return null;
}

function parseAlertDeleteCommand(rawCommand: unknown): {
  alertRef: string;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }
  const matched = command.match(/^([A-Za-z0-9:._-]{1,120})$/i);
  if (!matched) {
    return null;
  }
  const alertRef = normalizeString(matched[1]);
  if (!alertRef) {
    return null;
  }
  return { alertRef };
}

function parseOptionsWatchRuleCreateCommand(rawCommand: unknown): {
  contractId: string;
  direction: GesahniOptionsWatchRuleDirection;
  thresholdValue: number;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }
  const matched = command.match(/^([0-9a-f-]{36})\s+(above|below)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i);
  if (!matched) {
    return null;
  }
  const contractId = normalizeUuid(matched[1]);
  const direction = normalizeAlertDirection(matched[2]) as GesahniOptionsWatchRuleDirection;
  const thresholdValue = normalizeThreshold(matched[3]);
  if (!contractId || !direction || thresholdValue === undefined) {
    return null;
  }
  return { contractId, direction, thresholdValue };
}

function parseOptionsWatchRuleUpdateCommand(rawCommand: unknown): {
  ruleId: string;
  direction?: GesahniOptionsWatchRuleDirection;
  thresholdValue?: number;
  enabled?: boolean;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }

  const thresholdMatch = command.match(/^([0-9a-f-]{36})\s+\$?([0-9]+(?:\.[0-9]+)?)$/i);
  if (thresholdMatch) {
    const ruleId = normalizeUuid(thresholdMatch[1]);
    const thresholdValue = normalizeThreshold(thresholdMatch[2]);
    if (!ruleId || thresholdValue === undefined) {
      return null;
    }
    return { ruleId, thresholdValue };
  }

  const directionalThresholdMatch = command.match(
    /^([0-9a-f-]{36})\s+(above|below)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (directionalThresholdMatch) {
    const ruleId = normalizeUuid(directionalThresholdMatch[1]);
    const direction = normalizeAlertDirection(
      directionalThresholdMatch[2],
    ) as GesahniOptionsWatchRuleDirection;
    const thresholdValue = normalizeThreshold(directionalThresholdMatch[3]);
    if (!ruleId || !direction || thresholdValue === undefined) {
      return null;
    }
    return { ruleId, direction, thresholdValue };
  }

  const enabledMatch = command.match(
    /^([0-9a-f-]{36})\s+enabled\s+(true|false|1|0|yes|no|on|off)$/i,
  );
  if (enabledMatch) {
    const ruleId = normalizeUuid(enabledMatch[1]);
    const enabled = normalizeEnabledFlag(enabledMatch[2]);
    if (!ruleId || enabled === undefined) {
      return null;
    }
    return { ruleId, enabled };
  }
  return null;
}

function parseOptionsWatchRuleDeleteCommand(rawCommand: unknown): {
  ruleId: string;
} | null {
  const command = normalizeString(rawCommand);
  if (!command) {
    return null;
  }
  const matched = command.match(/^([0-9a-f-]{36})$/i);
  if (!matched) {
    return null;
  }
  const ruleId = normalizeUuid(matched[1]);
  if (!ruleId) {
    return null;
  }
  return { ruleId };
}

function normalizeCooldownMinutes(value: unknown): number | undefined {
  const numberValue = normalizeNumber(value);
  if (numberValue === undefined) {
    return undefined;
  }
  const normalized = Math.trunc(numberValue);
  if (normalized < 0) {
    throw new Error("cooldown_minutes must be >= 0");
  }
  return normalized;
}

function resolveWatchlistWriteParams(
  raw: GesahniWatchlistWriteParams,
  fallbackUserId?: string,
): {
  userId: string;
  symbol: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    symbol: resolveSymbol(raw.symbol, raw.command),
  };
}

function resolveAlertCreateParams(
  raw: GesahniAlertCreateParams,
  fallbackUserId?: string,
): {
  userId: string;
  symbol: string;
  direction: GesahniAlertDirection;
  threshold: number;
} {
  const userId = resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId);
  const parsed = parseAlertCreateCommand(raw.command);
  const symbol = normalizeSymbol(raw.symbol) ?? parsed?.symbol;
  const direction = normalizeAlertDirection(raw.direction) ?? parsed?.direction;
  const threshold = normalizeThreshold(raw.threshold) ?? parsed?.threshold;
  if (!symbol) {
    throw new Error("symbol is required");
  }
  if (!direction) {
    throw new Error("direction is required");
  }
  if (threshold === undefined) {
    throw new Error("threshold is required");
  }
  return { userId, symbol, direction, threshold };
}

function resolveAlertUpdateParams(
  raw: GesahniAlertUpdateParams,
  fallbackUserId?: string,
): {
  userId: string;
  alertId?: string;
  symbol?: string;
  threshold?: number;
  enabled?: boolean;
} {
  const userId = resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId);
  const parsed = parseAlertUpdateCommand(raw.command);
  const rawAlertRef = parsed?.alertRef;
  const refLooksLikeAlertId =
    typeof rawAlertRef === "string" &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawAlertRef,
    ) ||
      /^alert[_:-]/i.test(rawAlertRef) ||
      rawAlertRef.length > 15);
  const directSymbol = normalizeSymbol(raw.symbol);
  const derivedSymbol =
    directSymbol ??
    (rawAlertRef && !raw.alert_id && !refLooksLikeAlertId
      ? normalizeSymbol(rawAlertRef)
      : undefined);
  const alertId =
    normalizeLookupId(raw.alert_id) ?? (derivedSymbol ? undefined : normalizeLookupId(rawAlertRef));
  const threshold = normalizeThreshold(raw.threshold) ?? parsed?.threshold;
  const enabled = normalizeEnabledFlag(raw.enabled) ?? parsed?.enabled;
  if (!alertId && !derivedSymbol) {
    throw new Error("alert_id or symbol is required");
  }
  if (threshold === undefined && enabled === undefined) {
    throw new Error("threshold or enabled is required");
  }
  return { userId, alertId, symbol: derivedSymbol, threshold, enabled };
}

function resolveAlertDeleteParams(
  raw: GesahniAlertDeleteParams,
  fallbackUserId?: string,
): {
  userId: string;
  alertId?: string;
  symbol?: string;
} {
  const parsed = parseAlertDeleteCommand(raw.command);
  const alertRefFromCommand = parsed?.alertRef;
  const refLooksLikeAlertId =
    typeof alertRefFromCommand === "string" &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      alertRefFromCommand,
    ) ||
      /^alert[_:-]/i.test(alertRefFromCommand) ||
      alertRefFromCommand.length > 15);
  const symbolFromCommand =
    alertRefFromCommand && !raw.alert_id && !refLooksLikeAlertId
      ? normalizeSymbol(alertRefFromCommand)
      : undefined;
  const symbol = normalizeSymbol(raw.symbol) ?? symbolFromCommand;
  const alertId =
    normalizeLookupId(raw.alert_id) ??
    (symbol ? undefined : normalizeLookupId(alertRefFromCommand));
  if (!alertId && !symbol) {
    throw new Error("alert_id or symbol is required");
  }
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    alertId,
    symbol,
  };
}

function resolveOptionsWatchRuleCreateParams(
  raw: GesahniOptionsWatchRuleCreateParams,
  fallbackUserId?: string,
): {
  userId: string;
  contractId: string;
  direction: GesahniOptionsWatchRuleDirection;
  thresholdValue: number;
  enabled: boolean;
  cooldownMinutes?: number;
} {
  const userId = resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId);
  const parsed = parseOptionsWatchRuleCreateCommand(raw.command);
  const contractId = normalizeUuid(raw.contract_id) ?? parsed?.contractId;
  const direction =
    (normalizeAlertDirection(raw.direction) as GesahniOptionsWatchRuleDirection | undefined) ??
    parsed?.direction ??
    "above";
  const thresholdValue = normalizeThreshold(raw.threshold_value) ?? parsed?.thresholdValue;
  const enabled = normalizeEnabledFlag(raw.enabled) ?? true;
  const cooldownMinutes = normalizeCooldownMinutes(raw.cooldown_minutes);
  if (!contractId) {
    throw new Error("contract_id is required");
  }
  if (!direction) {
    throw new Error("direction is required");
  }
  if (thresholdValue === undefined) {
    throw new Error("threshold_value is required");
  }
  return {
    userId,
    contractId,
    direction,
    thresholdValue,
    enabled,
    cooldownMinutes,
  };
}

function resolveOptionsWatchRuleUpdateParams(
  raw: GesahniOptionsWatchRuleUpdateParams,
  fallbackUserId?: string,
): {
  userId: string;
  ruleId: string;
  direction?: GesahniOptionsWatchRuleDirection;
  thresholdValue?: number;
  enabled?: boolean;
  cooldownMinutes?: number;
} {
  const userId = resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId);
  const parsed = parseOptionsWatchRuleUpdateCommand(raw.command);
  const ruleId = normalizeUuid(raw.rule_id) ?? parsed?.ruleId;
  const direction =
    (normalizeAlertDirection(raw.direction) as GesahniOptionsWatchRuleDirection | undefined) ??
    parsed?.direction;
  const thresholdValue = normalizeThreshold(raw.threshold_value) ?? parsed?.thresholdValue;
  const enabled = normalizeEnabledFlag(raw.enabled) ?? parsed?.enabled;
  const cooldownMinutes = normalizeCooldownMinutes(raw.cooldown_minutes);
  if (!ruleId) {
    throw new Error("rule_id is required");
  }
  if (
    thresholdValue === undefined &&
    enabled === undefined &&
    !direction &&
    cooldownMinutes === undefined
  ) {
    throw new Error("at least one update field is required");
  }
  return {
    userId,
    ruleId,
    direction,
    thresholdValue,
    enabled,
    cooldownMinutes,
  };
}

function resolveOptionsWatchRuleDeleteParams(
  raw: GesahniOptionsWatchRuleDeleteParams,
  fallbackUserId?: string,
): {
  userId: string;
  ruleId: string;
} {
  const parsed = parseOptionsWatchRuleDeleteCommand(raw.command);
  const ruleId = normalizeUuid(raw.rule_id) ?? parsed?.ruleId;
  if (!ruleId) {
    throw new Error("rule_id is required");
  }
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    ruleId,
  };
}

function resolveOptionsSuggestionApplyParams(
  raw: GesahniOptionsSuggestionApplyParams,
  fallbackUserId?: string,
): {
  userId: string;
  suggestionId: string;
} {
  const directSuggestionId = normalizeUuid(raw.suggestion_id);
  const commandSuggestionId = normalizeUuid(raw.command);
  const suggestionId = directSuggestionId ?? commandSuggestionId;
  if (!suggestionId) {
    throw new Error("suggestion_id is required");
  }
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    suggestionId,
  };
}

function resolveOptionsSuggestionsApplyAllParams(
  raw: GesahniOptionsSuggestionsApplyAllParams,
  fallbackUserId?: string,
): {
  userId: string;
} {
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
  };
}

function resolveWriteConfirmParams(
  raw: GesahniWriteConfirmParams,
  fallbackUserId?: string,
): {
  userId: string;
  pendingActionId?: string;
} {
  const directPendingId = normalizeLookupId(raw.pending_action_id);
  const commandPendingId = normalizeLookupId(raw.command);
  return {
    userId: resolveEffectiveGesahniUserId(raw.user_id, fallbackUserId),
    pendingActionId: directPendingId ?? commandPendingId,
  };
}

function countValue(payload: Record<string, unknown>, key: string, fallback: number): number {
  const raw = payload[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  return fallback;
}

function formatTopList(values: string[], count: number): string {
  if (count <= 0) {
    return "none";
  }
  const top = values.slice(0, 10).join(", ");
  if (count <= 10) {
    return top;
  }
  return `${top} (+${count - 10} more)`;
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
}

function asRecordList(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

function formatCurrency(value: unknown): string | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(numeric);
}

function findRecordList(
  payload: Record<string, unknown>,
  keys: string[],
): Array<Record<string, unknown>> {
  for (const key of keys) {
    const list = asRecordList(payload[key]);
    if (list.length > 0) {
      return list;
    }
  }
  return [];
}

function recordLabel(item: Record<string, unknown>, keys: string[], fallback = "UNKNOWN"): string {
  for (const key of keys) {
    const value = normalizeString(item[key]);
    if (value) {
      return value;
    }
  }
  return fallback;
}

function formatWatchlist(payload: Record<string, unknown>): string {
  const watchlist = asStringList(payload.watchlist);
  const count = countValue(payload, "count", watchlist.length);
  if (count === 0) {
    return "Watchlist (0).";
  }
  return `Watchlist (${count}): ${formatTopList(watchlist, count)}`;
}

function formatPositions(payload: Record<string, unknown>): string {
  const positions = asRecordList(payload.positions);
  const top = positions.slice(0, 10).map((item) => {
    const ticker = normalizeString(item.ticker) ?? normalizeString(item.symbol) ?? "UNKNOWN";
    const qty =
      normalizeNumber(item.shares) ?? normalizeNumber(item.qty) ?? normalizeNumber(item.quantity);
    return qty !== undefined ? `${ticker} (${qty})` : ticker;
  });
  const count = countValue(payload, "count", positions.length);
  if (count === 0) {
    return "Positions (0).";
  }
  return `Positions (${count}): ${formatTopList(top, count)}`;
}

function formatAlerts(payload: Record<string, unknown>): string {
  const alerts = asRecordList(payload.alerts);
  const top = alerts.slice(0, 10).map((item) => {
    const ticker = normalizeString(item.ticker) ?? "UNKNOWN";
    const direction = normalizeString(item.direction) ?? "";
    const threshold = normalizeString(String(item.threshold ?? "")) ?? "";
    const detail = [direction, threshold].filter(Boolean).join(" ");
    return detail ? `${ticker} ${detail}` : ticker;
  });
  const count = countValue(payload, "count", alerts.length);
  if (count === 0) {
    return "Alerts (0).";
  }
  return `Alerts (${count}): ${formatTopList(top, count)}`;
}

type StockAlertRecord = {
  alertId: string;
  symbol?: string;
  direction?: GesahniAlertDirection;
  threshold?: number;
  enabled?: boolean;
};

function asStockAlertRecord(item: Record<string, unknown>): StockAlertRecord | null {
  const alertId = normalizeLookupId(item.id) ?? normalizeLookupId(item.alert_id);
  if (!alertId) {
    return null;
  }
  return {
    alertId,
    symbol: normalizeSymbol(item.ticker) ?? normalizeSymbol(item.symbol),
    direction: normalizeAlertDirection(item.direction),
    threshold: normalizeThreshold(item.threshold_value ?? item.threshold),
    enabled: normalizeEnabledFlag(item.enabled),
  };
}

function findStockAlertBySymbol(
  payload: Record<string, unknown>,
  symbol: string,
): StockAlertRecord {
  const wanted = normalizeSymbol(symbol);
  if (!wanted) {
    throw new Error("symbol is required");
  }
  const alerts = findRecordList(payload, ["alerts", "items", "watch_rules"]);
  const candidates: StockAlertRecord[] = [];
  for (const alert of alerts) {
    const parsed = asStockAlertRecord(alert);
    if (!parsed) {
      continue;
    }
    if (parsed.symbol === wanted) {
      candidates.push(parsed);
    }
  }
  if (candidates.length === 0) {
    throw new Error(`no alert found for ${wanted}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple alerts found for ${wanted}; specify alert_id to avoid ambiguous update/delete`,
    );
  }
  const resolved = candidates[0];
  if (!resolved) {
    throw new Error(`no alert found for ${wanted}`);
  }
  return resolved;
}

type OptionsWatchRuleRecord = {
  ruleId: string;
  direction?: GesahniOptionsWatchRuleDirection;
  thresholdValue?: number;
  enabled?: boolean;
  contractId?: string;
  contractKey?: string;
  underlying?: string;
};

function asOptionsWatchRuleRecord(item: Record<string, unknown>): OptionsWatchRuleRecord | null {
  const ruleId = normalizeUuid(item.id) ?? normalizeUuid(item.rule_id);
  if (!ruleId) {
    return null;
  }
  return {
    ruleId,
    direction: normalizeAlertDirection(item.direction) as
      | GesahniOptionsWatchRuleDirection
      | undefined,
    thresholdValue: normalizeThreshold(item.threshold_value ?? item.threshold),
    enabled: normalizeEnabledFlag(item.enabled),
    contractId: normalizeUuid(item.contract_id),
    contractKey: normalizeString(item.contract_key),
    underlying: normalizeString(item.contract_underlying) ?? normalizeString(item.underlying),
  };
}

function findOptionsWatchRuleById(
  payload: Record<string, unknown>,
  ruleId: string,
): OptionsWatchRuleRecord {
  const wanted = normalizeUuid(ruleId);
  if (!wanted) {
    throw new Error("rule_id is required");
  }
  const rules = findRecordList(payload, ["watch_rules", "rules", "items"]);
  for (const item of rules) {
    const parsed = asOptionsWatchRuleRecord(item);
    if (parsed?.ruleId === wanted) {
      return parsed;
    }
  }
  throw new Error(`no watch rule found for ${wanted}`);
}

type OptionsSuggestionRecord = {
  suggestionId: string;
  contractId?: string;
  contractKey?: string;
  recommendationStatus?: string;
  recommendationReason?: string;
  underlying?: string;
};

function asOptionsSuggestionRecord(item: Record<string, unknown>): OptionsSuggestionRecord | null {
  const suggestionId = normalizeUuid(item.position_id) ?? normalizeUuid(item.suggestion_id);
  if (!suggestionId) {
    return null;
  }
  return {
    suggestionId,
    contractId: normalizeUuid(item.contract_id),
    contractKey: normalizeString(item.contract_key),
    recommendationStatus: normalizeString(item.recommendation_status),
    recommendationReason: normalizeString(item.recommendation_reason),
    underlying: normalizeString(item.underlying),
  };
}

function listReadyOptionsSuggestions(payload: Record<string, unknown>): OptionsSuggestionRecord[] {
  const suggestions = findRecordList(payload, ["items", "suggestions"]);
  const ready: OptionsSuggestionRecord[] = [];
  for (const item of suggestions) {
    const parsed = asOptionsSuggestionRecord(item);
    if (!parsed) {
      continue;
    }
    if ((parsed.recommendationStatus ?? "").toLowerCase() === "ready") {
      ready.push(parsed);
    }
  }
  return ready;
}

function findOptionsSuggestionById(
  payload: Record<string, unknown>,
  suggestionId: string,
): OptionsSuggestionRecord {
  const wanted = normalizeUuid(suggestionId);
  if (!wanted) {
    throw new Error("suggestion_id is required");
  }
  const suggestions = findRecordList(payload, ["items", "suggestions"]);
  for (const item of suggestions) {
    const parsed = asOptionsSuggestionRecord(item);
    if (!parsed) {
      continue;
    }
    if (parsed.suggestionId !== wanted) {
      continue;
    }
    const status = (parsed.recommendationStatus ?? "").toLowerCase();
    if (status && status !== "ready") {
      throw new Error(
        `suggestion ${wanted} is not ready (${parsed.recommendationReason ?? parsed.recommendationStatus ?? "unknown"})`,
      );
    }
    return parsed;
  }
  throw new Error(`no suggestion found for ${wanted}`);
}

function formatEarnings(payload: Record<string, unknown>): string {
  const events = asRecordList(payload.events);
  const top = events.slice(0, 10).map((item) => {
    const ticker = normalizeString(item.symbol) ?? normalizeString(item.ticker) ?? "UNKNOWN";
    const when =
      normalizeString(item.date) ??
      normalizeString(item.earnings_date) ??
      normalizeString(item.report_date) ??
      "";
    return when ? `${ticker} (${when})` : ticker;
  });
  const count = countValue(payload, "count", events.length);
  if (count === 0) {
    return "Earnings (0).";
  }
  return `Earnings (${count}): ${formatTopList(top, count)}`;
}

function formatSummary(payload: Record<string, unknown>): string {
  const generatedAt = normalizeString(payload.generated_at) ?? "unknown";
  const marketHours =
    typeof payload.market_hours === "object" && payload.market_hours
      ? (payload.market_hours as Record<string, unknown>)
      : {};
  const isOpen = Boolean(marketHours.is_open);
  const nextOpen = normalizeString(marketHours.next_open_local) ?? "n/a";
  return `Market summary: ${isOpen ? "open" : "closed"} (generated ${generatedAt}, next open ${nextOpen}).`;
}

function formatPortfolio(payload: Record<string, unknown>): string {
  const holdings = findRecordList(payload, ["holdings", "positions", "portfolio"]);
  const count = countValue(payload, "count", holdings.length);
  const totalValue =
    formatCurrency(payload.total_value) ??
    formatCurrency(payload.totalValue) ??
    formatCurrency(payload.market_value);
  const cash = formatCurrency(payload.cash);
  const details = [totalValue ? `value ${totalValue}` : null, cash ? `cash ${cash}` : null].filter(
    Boolean,
  );
  if (count === 0) {
    return details.length > 0 ? `Portfolio (0, ${details.join(", ")}).` : "Portfolio (0).";
  }
  const top = holdings.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker"]);
    const quantity =
      normalizeNumber(item.quantity) ?? normalizeNumber(item.shares) ?? normalizeNumber(item.qty);
    return quantity !== undefined ? `${symbol} (${quantity})` : symbol;
  });
  const suffix = details.length > 0 ? `; ${details.join(", ")}` : "";
  return `Portfolio (${count}): ${formatTopList(top, count)}${suffix}`;
}

function formatOptionsPositions(payload: Record<string, unknown>): string {
  const positions = findRecordList(payload, ["positions", "contracts", "items"]);
  const count = countValue(payload, "count", positions.length);
  if (count === 0) {
    return "Options positions (0).";
  }
  const top = positions.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker", "underlying"]);
    const contract =
      normalizeString(item.contract) ??
      normalizeString(item.contract_symbol) ??
      normalizeString(item.occ_symbol);
    return contract ? `${symbol} ${contract}` : symbol;
  });
  return `Options positions (${count}): ${formatTopList(top, count)}`;
}

function formatOptionsWatchRules(payload: Record<string, unknown>): string {
  const rules = findRecordList(payload, ["rules", "watch_rules", "items"]);
  const count = countValue(payload, "count", rules.length);
  if (count === 0) {
    return "Option alerts (0).";
  }
  const top = rules.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker", "underlying"]);
    const state = normalizeString(item.status) ?? normalizeString(item.state) ?? "";
    return state ? `${symbol} (${state})` : symbol;
  });
  return `Option alerts (${count}): ${formatTopList(top, count)}`;
}

function formatOptionsStatus(payload: Record<string, unknown>): string {
  const status = normalizeString(payload.status) ?? normalizeString(payload.state) ?? "unknown";
  const activeRules =
    normalizeNumber(payload.active_rules) ?? normalizeNumber(payload.activeRules) ?? 0;
  const dueSuggestions =
    normalizeNumber(payload.alert_suggestions) ?? normalizeNumber(payload.suggestions) ?? 0;
  return `Options status: ${status} (active rules ${activeRules}, suggestions ${dueSuggestions}).`;
}

function formatOptionsAlertSuggestions(payload: Record<string, unknown>): string {
  const suggestions = findRecordList(payload, ["suggestions", "items", "alerts"]);
  const count = countValue(payload, "count", suggestions.length);
  if (count === 0) {
    return "Option alert suggestions (0).";
  }
  const top = suggestions.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker", "underlying"]);
    const reason = normalizeString(item.reason) ?? normalizeString(item.kind) ?? "";
    return reason ? `${symbol} (${reason})` : symbol;
  });
  return `Option alert suggestions (${count}): ${formatTopList(top, count)}`;
}

function formatWatchRuleEvents(payload: Record<string, unknown>): string {
  const events = findRecordList(payload, ["events", "items"]);
  const count = countValue(payload, "count", events.length);
  if (count === 0) {
    return "Watch rule events (0).";
  }
  const top = events.slice(0, 10).map((item) => {
    const kind = recordLabel(item, ["event", "kind", "type"], "event");
    const when = recordLabel(item, ["created_at", "timestamp", "at"], "");
    return when ? `${kind} (${when})` : kind;
  });
  return `Watch rule events (${count}): ${formatTopList(top, count)}`;
}

function formatChainSnapshot(payload: Record<string, unknown>, symbol: string): string {
  const expirations =
    asStringList(payload.expirations).length || asRecordList(payload.expiries).length;
  const contracts =
    countValue(payload, "count", 0) ||
    findRecordList(payload, ["contracts", "chain", "quotes"]).length;
  const updatedAt =
    normalizeString(payload.updated_at) ??
    normalizeString(payload.as_of) ??
    normalizeString(payload.timestamp);
  const parts = [
    expirations > 0 ? `${expirations} expiries` : null,
    contracts > 0 ? `${contracts} contracts` : null,
    updatedAt ? `updated ${updatedAt}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Chain ${symbol}: ${parts.join(", ")}.` : `Chain ${symbol}.`;
}

function formatQuotesBatch(payload: Record<string, unknown>): string {
  const quotes = findRecordList(payload, ["quotes", "items"]);
  const count = countValue(payload, "count", quotes.length);
  if (count === 0) {
    return "Quotes (0).";
  }
  const top = quotes.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker"]);
    const price =
      formatCurrency(item.last) ??
      formatCurrency(item.last_price) ??
      formatCurrency(item.price) ??
      formatCurrency(item.mark);
    return price ? `${symbol} ${price}` : symbol;
  });
  return `Quotes (${count}): ${formatTopList(top, count)}`;
}

function formatQuote(payload: Record<string, unknown>): string {
  const formatSource = (value: unknown): string | undefined => {
    const source = normalizeString(value);
    if (!source) {
      return undefined;
    }
    if (/^[a-z]+$/.test(source)) {
      return `${source[0]!.toUpperCase()}${source.slice(1)}`;
    }
    return source;
  };
  const resolveSource = (quote?: Record<string, unknown>): string | undefined => {
    return (
      formatSource(quote?.provider) ??
      formatSource(quote?.source) ??
      formatSource(quote?.venue) ??
      formatSource(quote?.exchange) ??
      formatSource(payload.provider) ??
      formatSource(payload.source) ??
      formatSource(payload.data_source) ??
      formatSource(payload.vendor)
    );
  };
  const resolveErrorDetail = (quote?: Record<string, unknown>): string | undefined => {
    return (
      normalizeString(quote?.error) ??
      normalizeString(quote?.error_message) ??
      normalizeString(quote?.reason) ??
      normalizeString(payload.error) ??
      normalizeString(payload.error_message) ??
      normalizeString(payload.message) ??
      normalizeString(payload.detail)
    );
  };

  const quotes = findRecordList(payload, ["quotes", "items"]);
  if (quotes.length === 0) {
    const source = resolveSource();
    const detail = resolveErrorDetail();
    if (source && detail) {
      return `Quote unavailable (source: ${source}; detail: ${detail}).`;
    }
    if (source) {
      return `Quote unavailable (source: ${source}).`;
    }
    if (detail) {
      return `Quote unavailable (${detail}).`;
    }
    return "Quote unavailable.";
  }
  const quote = quotes[0];
  const symbol = recordLabel(quote, ["symbol", "ticker"]);
  const source = resolveSource(quote) ?? "Unknown";
  const price =
    formatCurrency(quote.last) ??
    formatCurrency(quote.last_price) ??
    formatCurrency(quote.price) ??
    formatCurrency(quote.mark);
  if (!price) {
    const detail = resolveErrorDetail(quote);
    if (detail) {
      return `Quote ${symbol}: unavailable (source: ${source}; detail: ${detail}).`;
    }
    return `Quote ${symbol}: unavailable (source: ${source}).`;
  }
  return `Quote ${symbol} (source: ${source}): ${price}.`;
}

function formatEarningsCoverage(payload: Record<string, unknown>): string {
  const covered = normalizeNumber(payload.covered) ?? normalizeNumber(payload.covered_count) ?? 0;
  const uncovered =
    normalizeNumber(payload.uncovered) ?? normalizeNumber(payload.uncovered_count) ?? 0;
  const total = normalizeNumber(payload.total) ?? covered + uncovered;
  return `Earnings coverage: ${covered}/${total} covered, ${uncovered} uncovered.`;
}

function formatEarningsReminders(label: string, payload: Record<string, unknown>): string {
  const reminders = findRecordList(payload, ["reminders", "items", "events"]);
  const count = countValue(payload, "count", reminders.length);
  if (count === 0) {
    return `${label} reminders (0).`;
  }
  const top = reminders.slice(0, 10).map((item) => {
    const symbol = recordLabel(item, ["symbol", "ticker"]);
    const when = recordLabel(item, ["date", "scheduled_for", "sent_at", "due_at"], "");
    return when ? `${symbol} (${when})` : symbol;
  });
  return `${label} reminders (${count}): ${formatTopList(top, count)}`;
}

function formatAlertDeliveries(payload: Record<string, unknown>): string {
  const deliveries = findRecordList(payload, ["deliveries", "items"]);
  const count = countValue(payload, "count", deliveries.length);
  if (count === 0) {
    return "Alert history (0).";
  }
  const top = deliveries.slice(0, 10).map((item) => {
    const status = recordLabel(item, ["status", "state"], "unknown");
    const when = recordLabel(item, ["sent_at", "created_at", "timestamp"], "");
    return when ? `${status} (${when})` : status;
  });
  return `Alert history (${count}): ${formatTopList(top, count)}`;
}

export function resolveGesahniConfig(pluginConfig?: Record<string, unknown>): GesahniPluginConfig {
  const baseUrl =
    normalizeString(pluginConfig?.baseUrl) ??
    normalizeString(process.env.GESAHNI_BASE_URL) ??
    "http://127.0.0.1:8000";
  const readBridgeToken =
    normalizeString(pluginConfig?.readBridgeToken) ??
    normalizeString(process.env.GESAHNI_READ_BRIDGE_TOKEN) ??
    "";
  const writeBridgeToken =
    normalizeString(pluginConfig?.writeBridgeToken) ??
    normalizeString(process.env.GESAHNI_WRITE_BRIDGE_TOKEN) ??
    "";
  const defaultTimeoutMs = normalizeTimeout(
    pluginConfig?.defaultTimeoutMs ?? process.env.GESAHNI_DEFAULT_TIMEOUT_MS,
  );

  if (!baseUrl) {
    throw new Error("gesahni baseUrl is required");
  }
  if (!readBridgeToken) {
    throw new Error("gesahni readBridgeToken is required");
  }

  return {
    baseUrl: trimTrailingSlash(baseUrl),
    readBridgeToken,
    writeBridgeToken,
    defaultTimeoutMs,
  };
}

export function createGesahniService(options: {
  config: GesahniPluginConfig;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const { config } = options;

  const requestBridge = async <T>(req: BridgeRequestOptions): Promise<T> => {
    const url = buildBridgeUrl(config.baseUrl, req.path, req.query);
    const bridgeToken = req.auth === "write" ? config.writeBridgeToken : config.readBridgeToken;
    if (!bridgeToken) {
      throw new Error(
        req.auth === "write"
          ? "gesahni writeBridgeToken is required for write confirmations"
          : "gesahni readBridgeToken is required",
      );
    }
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bridgeToken}`,
      "X-User-Id": req.userId,
    };
    if (req.idempotencyKey) {
      headers["Idempotency-Key"] = req.idempotencyKey;
    }
    if (req.body) {
      headers["Content-Type"] = "application/json";
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, config.defaultTimeoutMs);

      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          throw new Error(`bridge authorization failed (${response.status})`);
        }
        const lookupFailure =
          req.auth === "read" ? idLookupFailureMessage(req.path, response.status) : undefined;
        if (lookupFailure) {
          throw new Error(lookupFailure);
        }
        if (response.status >= 500) {
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleepImpl(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          const detail = await parseBridgeErrorDetail(response);
          throw new Error(formatBridgeEndpointFailure(req.path, response.status, detail));
        }
        if (!response.ok) {
          const detail = await parseBridgeErrorDetail(response);
          throw new Error(formatBridgeEndpointFailure(req.path, response.status, detail));
        }
        if (response.status === 204) {
          return {} as T;
        }
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("application/json")) {
          return {} as T;
        }
        return (await response.json()) as T;
      } catch (error) {
        if (isAbortError(error)) {
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleepImpl(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          throw new Error(`bridge request timed out (${config.defaultTimeoutMs}ms)`);
        }
        const statusRetryable =
          error instanceof Error &&
          /failed \(5\d\d\)/.test(error.message) &&
          attempt < RETRY_DELAYS_MS.length;
        if (statusRetryable) {
          await sleepImpl(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  return {
    watchlistGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/watchlist",
        userId: params.userId,
        auth: "read",
      }),
    positionsGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/positions",
        userId: params.userId,
        auth: "read",
      }),
    marketSummaryGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/market/summary",
        userId: params.userId,
        auth: "read",
      }),
    alertsGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/alerts",
        userId: params.userId,
        auth: "read",
      }),
    earningsUpcomingGet: async (params: { userId: string; days: number; symbols?: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/earnings/upcoming",
        userId: params.userId,
        auth: "read",
        query: {
          days: params.days,
          symbols: params.symbols,
        },
      }),
    portfolioGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/portfolio",
        userId: params.userId,
        auth: "read",
      }),
    optionsPositionsGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/positions",
        userId: params.userId,
        auth: "read",
      }),
    optionsWatchRulesGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/watch_rules",
        userId: params.userId,
        auth: "read",
      }),
    optionsStatusGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/status",
        userId: params.userId,
        auth: "read",
      }),
    optionsAlertSuggestionsGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/alert_suggestions",
        userId: params.userId,
        auth: "read",
      }),
    optionsWatchRuleEventsGet: async (params: { userId: string; id: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.id)}/events`,
        userId: params.userId,
        auth: "read",
      }),
    optionsChainSnapshotGet: async (params: { userId: string; symbol: string }) =>
      await readGuardedCachedBridge({
        cache: chainSnapshotCache,
        cacheKey: `${params.userId}:${params.symbol}`,
        cacheTtlMs: CHAIN_CACHE_TTL_MS,
        limiterKey: `chain:${params.userId}`,
        limit: CHAIN_RATE_LIMIT_MAX,
        label: "chain snapshot",
        fetcher: async () =>
          await requestBridge<Record<string, unknown>>({
            path: "/v1/bridge/options/chain_snapshot",
            userId: params.userId,
            auth: "read",
            query: {
              symbol: params.symbol,
            },
          }),
      }),
    optionsQuotesBatchGet: async (params: { userId: string; symbols: string }) =>
      await readGuardedCachedBridge({
        cache: quotesBatchCache,
        cacheKey: `${params.userId}:${params.symbols}`,
        cacheTtlMs: QUOTES_CACHE_TTL_MS,
        limiterKey: `quotes:${params.userId}`,
        limit: QUOTES_RATE_LIMIT_MAX,
        label: "quotes batch",
        fetcher: async () =>
          await requestBridge<Record<string, unknown>>({
            path: "/v1/bridge/options/quotes_batch",
            userId: params.userId,
            auth: "read",
            query: {
              symbols: params.symbols,
            },
          }),
      }),
    stockQuoteGet: async (params: { userId: string; symbol: string }) =>
      await readGuardedCachedBridge({
        cache: quotesBatchCache,
        cacheKey: `${params.userId}:${params.symbol}`,
        cacheTtlMs: QUOTES_CACHE_TTL_MS,
        limiterKey: `quotes:${params.userId}`,
        limit: QUOTES_RATE_LIMIT_MAX,
        label: "quote",
        fetcher: async () =>
          await requestBridge<Record<string, unknown>>({
            path: "/v1/bridge/stock/quote",
            userId: params.userId,
            auth: "read",
            query: {
              symbol: params.symbol,
            },
          }),
      }),
    earningsCoverageGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/earnings/coverage",
        userId: params.userId,
        auth: "read",
      }),
    earningsRemindersDueGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/earnings/reminders/due",
        userId: params.userId,
        auth: "read",
      }),
    earningsRemindersSentGet: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/earnings/reminders/sent",
        userId: params.userId,
        auth: "read",
      }),
    alertDeliveriesGet: async (params: { userId: string; alertId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/alerts/${encodeURIComponent(params.alertId)}/deliveries`,
        userId: params.userId,
        auth: "read",
      }),
    linkInitiate: async (params: { userId: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/link/initiate",
        method: "POST",
        userId: params.userId,
        auth: "read",
      }),
    watchlistAdd: async (params: { userId: string; symbol: string; idempotencyKey: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/watchlist",
        method: "POST",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
        body: {
          symbol: params.symbol,
        },
      }),
    watchlistRemove: async (params: { userId: string; symbol: string; idempotencyKey: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/watchlist/${encodeURIComponent(params.symbol)}`,
        method: "DELETE",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
      }),
    alertCreate: async (params: {
      userId: string;
      symbol: string;
      direction: GesahniAlertDirection;
      threshold: number;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/alerts",
        method: "POST",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
        body: {
          symbol: params.symbol,
          direction: params.direction,
          threshold: params.threshold,
        },
      }),
    alertUpdate: async (params: {
      userId: string;
      alertId: string;
      threshold?: number;
      enabled?: boolean;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/alerts/${encodeURIComponent(params.alertId)}`,
        method: "PATCH",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
        body: {
          ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
          ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        },
      }),
    alertDelete: async (params: { userId: string; alertId: string; idempotencyKey: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/alerts/${encodeURIComponent(params.alertId)}`,
        method: "DELETE",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
      }),
    optionsWatchRuleCreate: async (params: {
      userId: string;
      contractId: string;
      direction: GesahniOptionsWatchRuleDirection;
      thresholdValue: number;
      enabled: boolean;
      cooldownMinutes?: number;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/watch_rules",
        method: "POST",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
        body: {
          contract_id: params.contractId,
          direction: params.direction,
          threshold_value: params.thresholdValue,
          enabled: params.enabled,
          ...(params.cooldownMinutes !== undefined
            ? { cooldown_minutes: params.cooldownMinutes }
            : {}),
        },
      }),
    optionsWatchRuleUpdate: async (params: {
      userId: string;
      ruleId: string;
      direction?: GesahniOptionsWatchRuleDirection;
      thresholdValue?: number;
      enabled?: boolean;
      cooldownMinutes?: number;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.ruleId)}`,
        method: "PATCH",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
        body: {
          ...(params.direction !== undefined ? { direction: params.direction } : {}),
          ...(params.thresholdValue !== undefined
            ? { threshold_value: params.thresholdValue }
            : {}),
          ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
          ...(params.cooldownMinutes !== undefined
            ? { cooldown_minutes: params.cooldownMinutes }
            : {}),
        },
      }),
    optionsWatchRuleDelete: async (params: {
      userId: string;
      ruleId: string;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.ruleId)}`,
        method: "DELETE",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
      }),
    optionsAlertSuggestionApplyOne: async (params: {
      userId: string;
      suggestionId: string;
      idempotencyKey: string;
    }) =>
      await requestBridge<Record<string, unknown>>({
        path: `/v1/bridge/options/alert_suggestions/${encodeURIComponent(params.suggestionId)}/apply`,
        method: "POST",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
      }),
    optionsAlertSuggestionsApplyAll: async (params: { userId: string; idempotencyKey: string }) =>
      await requestBridge<Record<string, unknown>>({
        path: "/v1/bridge/options/alert_suggestions/apply_all",
        method: "POST",
        userId: params.userId,
        auth: "write",
        idempotencyKey: params.idempotencyKey,
      }),
  };
}

function formatWritePreviewText(params: { summary: string }) {
  return `Preview: ${params.summary}. Reply confirm to continue.`;
}

function normalizeFiniteDecimal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return undefined;
}

function formatNumericField(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function formatWriteConfirmResultText(result: Record<string, unknown>): string | null {
  const symbol = normalizeSymbol(result.symbol ?? result.ticker ?? result.underlying);
  const quantity = normalizeFiniteDecimal(result.quantity ?? result.qty ?? result.shares);
  const price = normalizeFiniteDecimal(
    result.price ?? result.avg_cost ?? result.entry_price ?? result.fill_price,
  );
  const tradeDate = normalizeString(result.trade_date ?? result.executed_at ?? result.created_at);
  const success =
    normalizeBoolean(result.success) ??
    normalizeBoolean(result.ok) ??
    normalizeBoolean(result.created) ??
    normalizeBoolean(result.updated) ??
    normalizeBoolean(result.deleted) ??
    normalizeBoolean(result.applied);

  const parts: string[] = [];
  if (symbol) {
    parts.push(`symbol ${symbol}`);
  }
  if (quantity !== undefined) {
    parts.push(`quantity ${formatNumericField(quantity)}`);
  }
  if (price !== undefined) {
    parts.push(`price ${formatNumericField(price)}`);
  }
  if (tradeDate) {
    parts.push(`trade_date ${tradeDate}`);
  }
  if (success !== undefined) {
    parts.push(`success ${String(success)}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatWriteConfirmedText(params: {
  summary: string;
  resultPayload: Record<string, unknown>;
}): string {
  const resultText = formatWriteConfirmResultText(params.resultPayload);
  if (!resultText) {
    return `Confirmed: ${params.summary}.`;
  }
  return `Confirmed: ${params.summary}. Result: ${resultText}.`;
}

function stagePendingWriteAction(params: {
  kind: PendingWriteKind;
  userId: string;
  chatScope: string;
  sessionScope: string;
  endpoint: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  summary: string;
}): PendingWriteAction {
  prunePendingWriteActions();
  const now = Date.now();
  const scopeKey = buildPendingScopeKey({
    userId: params.userId,
    chatScope: params.chatScope,
    sessionScope: params.sessionScope,
  });
  const pending: PendingWriteAction = {
    id: `gpa_${randomUUID()}`,
    kind: params.kind,
    userId: params.userId,
    scopeKey,
    idempotencyKey: `gesahni_${randomUUID()}`,
    endpoint: params.endpoint,
    method: params.method,
    body: params.body,
    summary: params.summary,
    createdAt: now,
    expiresAt: now + PENDING_WRITE_TTL_MS,
    state: "pending",
  };
  pendingWriteActions.set(scopeKey, pending);
  return pending;
}

function createWritePreviewExecute<TParams>(options: {
  toolName: string;
  run: (params: TParams) => Promise<{
    pending: PendingWriteAction;
  }>;
}) {
  return async (_toolCallId: string, rawParams: unknown) => {
    try {
      const result = await options.run(rawParams as TParams);
      return asToolResponse(
        {
          ok: true,
          tool: options.toolName,
          stage: "preview",
          pending_action_id: result.pending.id,
          pending_scope: result.pending.scopeKey,
          expires_at: new Date(result.pending.expiresAt).toISOString(),
          idempotency_key: result.pending.idempotencyKey,
          summary: result.pending.summary,
          kind: result.pending.kind,
        },
        formatWritePreviewText({
          summary: result.pending.summary,
        }),
      );
    } catch (error) {
      const message = errorMessage(error);
      return asToolResponse(
        {
          ok: false,
          tool: options.toolName,
          error: message,
        },
        `Bridge endpoint failed: ${message}`,
      );
    }
  };
}

function createSafeExecute<TParams>(options: {
  toolName: string;
  run: (
    params: TParams,
  ) => Promise<{ endpoint: string; payload: Record<string, unknown>; text: string }>;
}) {
  return async (_toolCallId: string, rawParams: unknown) => {
    try {
      const result = await options.run(rawParams as TParams);
      return asToolResponse(
        {
          ok: true,
          tool: options.toolName,
          endpoint: result.endpoint,
          payload: result.payload,
        },
        result.text,
      );
    } catch (error) {
      const message = errorMessage(error);
      return asToolResponse(
        {
          ok: false,
          tool: options.toolName,
          error: message,
        },
        `Bridge endpoint failed: ${message}`,
      );
    }
  };
}

export function createGesahniTools(options: {
  api: OpenClawPluginApi;
  ctx?: OpenClawPluginToolContext;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
}): {
  watchlistGet: AnyAgentTool;
  watchlistAdd: AnyAgentTool;
  watchlistRemove: AnyAgentTool;
  positionsGet: AnyAgentTool;
  marketSummaryGet: AnyAgentTool;
  alertsGet: AnyAgentTool;
  alertCreate: AnyAgentTool;
  alertUpdate: AnyAgentTool;
  alertDelete: AnyAgentTool;
  optionsWatchRuleCreate: AnyAgentTool;
  optionsWatchRuleUpdate: AnyAgentTool;
  optionsWatchRuleDelete: AnyAgentTool;
  optionsAlertSuggestionApply: AnyAgentTool;
  optionsAlertSuggestionsApplyAll: AnyAgentTool;
  writeConfirm: AnyAgentTool;
  earningsUpcomingGet: AnyAgentTool;
  portfolioGet: AnyAgentTool;
  optionsPositionsGet: AnyAgentTool;
  optionsWatchRulesGet: AnyAgentTool;
  optionsStatusGet: AnyAgentTool;
  optionsAlertSuggestionsGet: AnyAgentTool;
  optionsWatchRuleEventsGet: AnyAgentTool;
  optionsChainSnapshotGet: AnyAgentTool;
  optionsQuotesBatchGet: AnyAgentTool;
  stockQuoteGet: AnyAgentTool;
  earningsCoverageGet: AnyAgentTool;
  earningsRemindersDueGet: AnyAgentTool;
  earningsRemindersSentGet: AnyAgentTool;
  alertDeliveriesGet: AnyAgentTool;
} {
  const buildService = () =>
    createGesahniService({
      config: resolveGesahniConfig(options.api.pluginConfig),
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
  const fallbackUserId = resolveGesahniUserIdFromToolContext(options.ctx);
  const scopeContext = resolveGesahniScopeContext(options.ctx);

  const toolNames = {
    watchlistGet: "gesahni_watchlist_get",
    watchlistAdd: "gesahni_watchlist_add",
    watchlistRemove: "gesahni_watchlist_remove",
    positionsGet: "gesahni_positions_get",
    marketSummaryGet: "gesahni_market_summary_get",
    alertsGet: "gesahni_alerts_get",
    alertCreate: "gesahni_alert_create",
    alertUpdate: "gesahni_alert_update",
    alertDelete: "gesahni_alert_delete",
    optionsWatchRuleCreate: "gesahni_options_watch_rule_create",
    optionsWatchRuleUpdate: "gesahni_options_watch_rule_update",
    optionsWatchRuleDelete: "gesahni_options_watch_rule_delete",
    optionsAlertSuggestionApply: "gesahni_options_alert_suggestion_apply",
    optionsAlertSuggestionsApplyAll: "gesahni_options_alert_suggestions_apply_all",
    writeConfirm: "gesahni_write_confirm",
    earningsUpcomingGet: "gesahni_earnings_upcoming_get",
    portfolioGet: "gesahni_portfolio_get",
    optionsPositionsGet: "gesahni_options_positions_get",
    optionsWatchRulesGet: "gesahni_options_watch_rules_get",
    optionsStatusGet: "gesahni_options_status_get",
    optionsAlertSuggestionsGet: "gesahni_options_alert_suggestions_get",
    optionsWatchRuleEventsGet: "gesahni_options_watch_rule_events_get",
    optionsChainSnapshotGet: "gesahni_options_chain_snapshot_get",
    optionsQuotesBatchGet: "gesahni_options_quotes_batch_get",
    stockQuoteGet: "gesahni_stock_quote_get",
    earningsCoverageGet: "gesahni_earnings_coverage_get",
    earningsRemindersDueGet: "gesahni_earnings_reminders_due_get",
    earningsRemindersSentGet: "gesahni_earnings_reminders_sent_get",
    alertDeliveriesGet: "gesahni_alert_deliveries_get",
  } as const;

  const watchlistGet: AnyAgentTool = {
    name: toolNames.watchlistGet,
    label: "Gesahni Watchlist",
    description: "Read-only watchlist from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.watchlistGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().watchlistGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/watchlist",
          payload,
          text: formatWatchlist(payload),
        };
      },
    }),
  };

  const watchlistAdd: AnyAgentTool = {
    name: toolNames.watchlistAdd,
    label: "Gesahni Watchlist Add",
    description:
      "Preview adding a symbol to your watchlist, then require explicit confirm before writing.",
    parameters: GesahniWatchlistWriteSchema,
    execute: createWritePreviewExecute<GesahniWatchlistWriteParams>({
      toolName: toolNames.watchlistAdd,
      run: async (raw) => {
        const params = resolveWatchlistWriteParams(raw, fallbackUserId);
        const pending = stagePendingWriteAction({
          kind: "watchlist_add",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: "/v1/bridge/watchlist",
          method: "POST",
          body: {
            symbol: params.symbol,
          },
          summary: `add ${params.symbol} to your watchlist`,
        });
        return { pending };
      },
    }),
  };

  const watchlistRemove: AnyAgentTool = {
    name: toolNames.watchlistRemove,
    label: "Gesahni Watchlist Remove",
    description:
      "Preview removing a symbol from your watchlist, then require explicit confirm before writing.",
    parameters: GesahniWatchlistWriteSchema,
    execute: createWritePreviewExecute<GesahniWatchlistWriteParams>({
      toolName: toolNames.watchlistRemove,
      run: async (raw) => {
        const params = resolveWatchlistWriteParams(raw, fallbackUserId);
        const pending = stagePendingWriteAction({
          kind: "watchlist_remove",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/watchlist/${encodeURIComponent(params.symbol)}`,
          method: "DELETE",
          body: {
            symbol: params.symbol,
          },
          summary: `remove ${params.symbol} from your watchlist`,
        });
        return { pending };
      },
    }),
  };

  const positionsGet: AnyAgentTool = {
    name: toolNames.positionsGet,
    label: "Gesahni Positions",
    description: "Read-only positions from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.positionsGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().positionsGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/positions",
          payload,
          text: formatPositions(payload),
        };
      },
    }),
  };

  const marketSummaryGet: AnyAgentTool = {
    name: toolNames.marketSummaryGet,
    label: "Gesahni Market Summary",
    description: "Read-only market summary from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.marketSummaryGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().marketSummaryGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/market/summary",
          payload,
          text: formatSummary(payload),
        };
      },
    }),
  };

  const alertsGet: AnyAgentTool = {
    name: toolNames.alertsGet,
    label: "Gesahni Alerts",
    description: "Read-only alerts from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.alertsGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().alertsGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/alerts",
          payload,
          text: formatAlerts(payload),
        };
      },
    }),
  };

  const alertCreate: AnyAgentTool = {
    name: toolNames.alertCreate,
    label: "Gesahni Alert Create",
    description:
      "Preview a threshold stock alert create write, then require explicit confirm before writing.",
    parameters: GesahniAlertCreateSchema,
    execute: createWritePreviewExecute<GesahniAlertCreateParams>({
      toolName: toolNames.alertCreate,
      run: async (raw) => {
        const params = resolveAlertCreateParams(raw, fallbackUserId);
        const pending = stagePendingWriteAction({
          kind: "alert_create",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: "/v1/bridge/alerts",
          method: "POST",
          body: {
            symbol: params.symbol,
            direction: params.direction,
            threshold: params.threshold,
          },
          summary: `create alert for ${params.symbol} crossing ${params.direction} ${formatThreshold(
            params.threshold,
          )}`,
        });
        return { pending };
      },
    }),
  };

  const alertUpdate: AnyAgentTool = {
    name: toolNames.alertUpdate,
    label: "Gesahni Alert Update",
    description:
      "Preview a stock alert update write, then require explicit confirm before writing.",
    parameters: GesahniAlertUpdateSchema,
    execute: createWritePreviewExecute<GesahniAlertUpdateParams>({
      toolName: toolNames.alertUpdate,
      run: async (raw) => {
        const params = resolveAlertUpdateParams(raw, fallbackUserId);
        let alertId = params.alertId;
        let priorThreshold: number | undefined;
        let priorEnabled: boolean | undefined;
        if (!alertId && params.symbol) {
          const alertsPayload = await buildService().alertsGet({ userId: params.userId });
          const match = findStockAlertBySymbol(alertsPayload, params.symbol);
          alertId = match.alertId;
          priorThreshold = match.threshold;
          priorEnabled = match.enabled;
        }
        if (!alertId) {
          throw new Error("alert_id or resolvable symbol is required");
        }
        const summaryParts: string[] = [`update alert ${alertId}`];
        if (params.threshold !== undefined) {
          const before = priorThreshold === undefined ? "?" : formatThreshold(priorThreshold);
          summaryParts.push(`threshold ${before} -> ${formatThreshold(params.threshold)}`);
        }
        if (params.enabled !== undefined) {
          const beforeEnabled = priorEnabled === undefined ? "?" : String(priorEnabled);
          summaryParts.push(`enabled ${beforeEnabled} -> ${String(params.enabled)}`);
        }
        const pending = stagePendingWriteAction({
          kind: "alert_update",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/alerts/${encodeURIComponent(alertId)}`,
          method: "PATCH",
          body: {
            alert_id: alertId,
            ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
          },
          summary: summaryParts.join(": "),
        });
        return { pending };
      },
    }),
  };

  const alertDelete: AnyAgentTool = {
    name: toolNames.alertDelete,
    label: "Gesahni Alert Delete",
    description: "Preview deleting a stock alert, then require explicit confirm before writing.",
    parameters: GesahniAlertDeleteSchema,
    execute: createWritePreviewExecute<GesahniAlertDeleteParams>({
      toolName: toolNames.alertDelete,
      run: async (raw) => {
        const params = resolveAlertDeleteParams(raw, fallbackUserId);
        let alertId = params.alertId;
        if (!alertId && params.symbol) {
          const alertsPayload = await buildService().alertsGet({ userId: params.userId });
          const match = findStockAlertBySymbol(alertsPayload, params.symbol);
          alertId = match.alertId;
        }
        if (!alertId) {
          throw new Error("alert_id or resolvable symbol is required");
        }
        const pending = stagePendingWriteAction({
          kind: "alert_delete",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/alerts/${encodeURIComponent(alertId)}`,
          method: "DELETE",
          summary: `delete alert ${alertId}`,
        });
        return { pending };
      },
    }),
  };

  const optionsWatchRuleCreate: AnyAgentTool = {
    name: toolNames.optionsWatchRuleCreate,
    label: "Gesahni Options Watch Rule Create",
    description:
      "Preview creating an option watch rule, then require explicit confirm before writing.",
    parameters: GesahniOptionsWatchRuleCreateSchema,
    execute: createWritePreviewExecute<GesahniOptionsWatchRuleCreateParams>({
      toolName: toolNames.optionsWatchRuleCreate,
      run: async (raw) => {
        const params = resolveOptionsWatchRuleCreateParams(raw, fallbackUserId);
        const pending = stagePendingWriteAction({
          kind: "options_watch_rule_create",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: "/v1/bridge/options/watch_rules",
          method: "POST",
          body: {
            contract_id: params.contractId,
            direction: params.direction,
            threshold_value: params.thresholdValue,
            enabled: params.enabled,
            ...(params.cooldownMinutes !== undefined
              ? { cooldown_minutes: params.cooldownMinutes }
              : {}),
          },
          summary: `create option watch rule for contract ${params.contractId}: premium ${
            params.direction
          } ${formatThreshold(params.thresholdValue)}`,
        });
        return { pending };
      },
    }),
  };

  const optionsWatchRuleUpdate: AnyAgentTool = {
    name: toolNames.optionsWatchRuleUpdate,
    label: "Gesahni Options Watch Rule Update",
    description:
      "Preview updating an option watch rule, then require explicit confirm before writing.",
    parameters: GesahniOptionsWatchRuleUpdateSchema,
    execute: createWritePreviewExecute<GesahniOptionsWatchRuleUpdateParams>({
      toolName: toolNames.optionsWatchRuleUpdate,
      run: async (raw) => {
        const params = resolveOptionsWatchRuleUpdateParams(raw, fallbackUserId);
        let beforeRule: OptionsWatchRuleRecord | null = null;
        try {
          const watchRulesPayload = await buildService().optionsWatchRulesGet({
            userId: params.userId,
          });
          beforeRule = findOptionsWatchRuleById(watchRulesPayload, params.ruleId);
        } catch (error) {
          void error;
        }
        const summaryParts: string[] = [`update option watch rule ${params.ruleId}`];
        if (params.thresholdValue !== undefined) {
          const before =
            beforeRule?.thresholdValue === undefined
              ? "?"
              : formatThreshold(beforeRule.thresholdValue);
          summaryParts.push(`threshold ${before} -> ${formatThreshold(params.thresholdValue)}`);
        }
        if (params.enabled !== undefined) {
          const beforeEnabled =
            beforeRule?.enabled === undefined ? "?" : String(Boolean(beforeRule.enabled));
          summaryParts.push(`enabled ${beforeEnabled} -> ${String(params.enabled)}`);
        }
        if (params.direction !== undefined) {
          const beforeDirection = beforeRule?.direction ?? "?";
          summaryParts.push(`direction ${beforeDirection} -> ${params.direction}`);
        }
        if (params.cooldownMinutes !== undefined) {
          summaryParts.push(`cooldown -> ${params.cooldownMinutes}m`);
        }
        const pending = stagePendingWriteAction({
          kind: "options_watch_rule_update",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.ruleId)}`,
          method: "PATCH",
          body: {
            rule_id: params.ruleId,
            ...(params.direction !== undefined ? { direction: params.direction } : {}),
            ...(params.thresholdValue !== undefined
              ? { threshold_value: params.thresholdValue }
              : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
            ...(params.cooldownMinutes !== undefined
              ? { cooldown_minutes: params.cooldownMinutes }
              : {}),
          },
          summary: summaryParts.join(": "),
        });
        return { pending };
      },
    }),
  };

  const optionsWatchRuleDelete: AnyAgentTool = {
    name: toolNames.optionsWatchRuleDelete,
    label: "Gesahni Options Watch Rule Delete",
    description:
      "Preview deleting an option watch rule, then require explicit confirm before writing.",
    parameters: GesahniOptionsWatchRuleDeleteSchema,
    execute: createWritePreviewExecute<GesahniOptionsWatchRuleDeleteParams>({
      toolName: toolNames.optionsWatchRuleDelete,
      run: async (raw) => {
        const params = resolveOptionsWatchRuleDeleteParams(raw, fallbackUserId);
        const pending = stagePendingWriteAction({
          kind: "options_watch_rule_delete",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.ruleId)}`,
          method: "DELETE",
          body: {
            rule_id: params.ruleId,
          },
          summary: `delete option watch rule ${params.ruleId}`,
        });
        return { pending };
      },
    }),
  };

  const optionsAlertSuggestionApply: AnyAgentTool = {
    name: toolNames.optionsAlertSuggestionApply,
    label: "Gesahni Option Suggestion Apply",
    description:
      "Preview applying one option alert suggestion, then require explicit confirm before writing.",
    parameters: GesahniOptionsSuggestionApplySchema,
    execute: createWritePreviewExecute<GesahniOptionsSuggestionApplyParams>({
      toolName: toolNames.optionsAlertSuggestionApply,
      run: async (raw) => {
        const params = resolveOptionsSuggestionApplyParams(raw, fallbackUserId);
        const suggestionsPayload = await buildService().optionsAlertSuggestionsGet({
          userId: params.userId,
        });
        const suggestion = findOptionsSuggestionById(suggestionsPayload, params.suggestionId);
        const suggestionLabel =
          suggestion.contractKey ??
          suggestion.contractId ??
          suggestion.underlying ??
          params.suggestionId;
        const pending = stagePendingWriteAction({
          kind: "options_alert_suggestion_apply",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: `/v1/bridge/options/alert_suggestions/${encodeURIComponent(params.suggestionId)}/apply`,
          method: "POST",
          body: {
            suggestion_id: params.suggestionId,
          },
          summary: `apply suggested option alert for ${suggestionLabel}`,
        });
        return { pending };
      },
    }),
  };

  const optionsAlertSuggestionsApplyAll: AnyAgentTool = {
    name: toolNames.optionsAlertSuggestionsApplyAll,
    label: "Gesahni Option Suggestions Apply All",
    description:
      "Preview applying all ready option alert suggestions, then require explicit confirm before writing.",
    parameters: GesahniOptionsSuggestionsApplyAllSchema,
    execute: createWritePreviewExecute<GesahniOptionsSuggestionsApplyAllParams>({
      toolName: toolNames.optionsAlertSuggestionsApplyAll,
      run: async (raw) => {
        const params = resolveOptionsSuggestionsApplyAllParams(raw, fallbackUserId);
        const suggestionsPayload = await buildService().optionsAlertSuggestionsGet({
          userId: params.userId,
        });
        const readySuggestions = listReadyOptionsSuggestions(suggestionsPayload);
        if (readySuggestions.length === 0) {
          throw new Error("no ready option alert suggestions to apply");
        }
        const readySuggestionIds = readySuggestions
          .map((entry) => entry.suggestionId)
          .sort((left, right) => left.localeCompare(right));
        const pending = stagePendingWriteAction({
          kind: "options_alert_suggestions_apply_all",
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
          endpoint: "/v1/bridge/options/alert_suggestions/apply_all",
          method: "POST",
          body: {
            expected_ready_count: readySuggestionIds.length,
            suggestion_ids: readySuggestionIds,
          },
          summary: `apply ${readySuggestionIds.length} suggested option alerts`,
        });
        return { pending };
      },
    }),
  };

  const writeConfirm: AnyAgentTool = {
    name: toolNames.writeConfirm,
    label: "Gesahni Write Confirm",
    description: "Execute the pending Gesahni write for the current Telegram DM scope.",
    parameters: GesahniWriteConfirmSchema,
    execute: createSafeExecute<GesahniWriteConfirmParams>({
      toolName: toolNames.writeConfirm,
      run: async (raw) => {
        const params = resolveWriteConfirmParams(raw, fallbackUserId);
        prunePendingWriteActions();
        const scopeKey = buildPendingScopeKey({
          userId: params.userId,
          chatScope: scopeContext.chatScope,
          sessionScope: scopeContext.sessionScope,
        });
        const pending = pendingWriteActions.get(scopeKey);
        if (!pending) {
          throw new Error("no pending write action for this Telegram DM session");
        }
        if (pending.userId !== params.userId) {
          throw new Error("pending write action does not match trusted Telegram DM identity");
        }
        if (params.pendingActionId && params.pendingActionId !== pending.id) {
          throw new Error("pending_action_id does not match active pending write");
        }
        if (pending.expiresAt <= Date.now()) {
          pendingWriteActions.delete(scopeKey);
          throw new Error("pending write action expired; preview again before confirming");
        }
        if (pending.state === "executing") {
          throw new Error("pending write confirmation already in progress");
        }
        pending.state = "executing";
        try {
          const service = buildService();
          let payload: Record<string, unknown>;
          if (pending.kind === "watchlist_add") {
            const symbol = normalizeSymbol(pending.body?.symbol);
            if (!symbol) {
              throw new Error("pending watchlist add is missing symbol");
            }
            payload = await service.watchlistAdd({
              userId: params.userId,
              symbol,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "watchlist_remove") {
            const symbol = normalizeSymbol(pending.body?.symbol);
            if (!symbol) {
              throw new Error("pending watchlist remove is missing symbol");
            }
            payload = await service.watchlistRemove({
              userId: params.userId,
              symbol,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "alert_create") {
            const symbol = normalizeSymbol(pending.body?.symbol);
            const direction = normalizeAlertDirection(pending.body?.direction);
            const threshold = normalizeThreshold(pending.body?.threshold);
            if (!symbol || !direction || threshold === undefined) {
              throw new Error("pending alert create is malformed");
            }
            payload = await service.alertCreate({
              userId: params.userId,
              symbol,
              direction,
              threshold,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "alert_update") {
            const alertId = normalizeLookupId(
              pending.body?.alert_id ?? pending.endpoint.split("/").at(-1),
            );
            const threshold = normalizeThreshold(pending.body?.threshold);
            const enabled = normalizeEnabledFlag(pending.body?.enabled);
            if (!alertId || (threshold === undefined && enabled === undefined)) {
              throw new Error("pending alert update is malformed");
            }
            payload = await service.alertUpdate({
              userId: params.userId,
              alertId,
              threshold,
              enabled,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "alert_delete") {
            const alertId = normalizeLookupId(pending.endpoint.split("/").at(-1));
            if (!alertId) {
              throw new Error("pending alert delete is malformed");
            }
            payload = await service.alertDelete({
              userId: params.userId,
              alertId,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "options_watch_rule_create") {
            const contractId = normalizeUuid(pending.body?.contract_id);
            const direction = normalizeAlertDirection(pending.body?.direction) as
              | GesahniOptionsWatchRuleDirection
              | undefined;
            const thresholdValue = normalizeThreshold(pending.body?.threshold_value);
            const enabled = normalizeEnabledFlag(pending.body?.enabled);
            const cooldownMinutes = normalizeCooldownMinutes(pending.body?.cooldown_minutes);
            if (
              !contractId ||
              !direction ||
              thresholdValue === undefined ||
              enabled === undefined
            ) {
              throw new Error("pending options watch rule create is malformed");
            }
            payload = await service.optionsWatchRuleCreate({
              userId: params.userId,
              contractId,
              direction,
              thresholdValue,
              enabled,
              cooldownMinutes,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "options_watch_rule_update") {
            const ruleId = normalizeUuid(
              pending.body?.rule_id ?? pending.endpoint.split("/").at(-1),
            );
            const direction = normalizeAlertDirection(pending.body?.direction) as
              | GesahniOptionsWatchRuleDirection
              | undefined;
            const thresholdValue = normalizeThreshold(pending.body?.threshold_value);
            const enabled = normalizeEnabledFlag(pending.body?.enabled);
            const cooldownMinutes = normalizeCooldownMinutes(pending.body?.cooldown_minutes);
            if (
              !ruleId ||
              (thresholdValue === undefined &&
                enabled === undefined &&
                direction === undefined &&
                cooldownMinutes === undefined)
            ) {
              throw new Error("pending options watch rule update is malformed");
            }
            payload = await service.optionsWatchRuleUpdate({
              userId: params.userId,
              ruleId,
              direction,
              thresholdValue,
              enabled,
              cooldownMinutes,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "options_watch_rule_delete") {
            const ruleId = normalizeUuid(
              pending.body?.rule_id ?? pending.endpoint.split("/").at(-1),
            );
            if (!ruleId) {
              throw new Error("pending options watch rule delete is malformed");
            }
            payload = await service.optionsWatchRuleDelete({
              userId: params.userId,
              ruleId,
              idempotencyKey: pending.idempotencyKey,
            });
          } else if (pending.kind === "options_alert_suggestion_apply") {
            const suggestionId = normalizeUuid(
              pending.body?.suggestion_id ?? pending.endpoint.split("/").at(-2),
            );
            if (!suggestionId) {
              throw new Error("pending options suggestion apply is malformed");
            }
            payload = await service.optionsAlertSuggestionApplyOne({
              userId: params.userId,
              suggestionId,
              idempotencyKey: pending.idempotencyKey,
            });
          } else {
            const expectedIds = Array.isArray(pending.body?.suggestion_ids)
              ? pending.body?.suggestion_ids
                  .map((value) => normalizeUuid(value))
                  .filter((value): value is string => Boolean(value))
                  .sort((left, right) => left.localeCompare(right))
              : [];
            const expectedReadyCount = normalizeNumber(pending.body?.expected_ready_count);
            const currentSuggestions = await service.optionsAlertSuggestionsGet({
              userId: params.userId,
            });
            const currentReadyIds = listReadyOptionsSuggestions(currentSuggestions)
              .map((entry) => entry.suggestionId)
              .sort((left, right) => left.localeCompare(right));
            if (
              expectedReadyCount !== undefined &&
              (expectedReadyCount !== currentReadyIds.length ||
                expectedIds.length !== currentReadyIds.length ||
                expectedIds.some((id, index) => id !== currentReadyIds[index]))
            ) {
              throw new Error("ready suggestion set changed; preview again before confirming");
            }
            payload = await service.optionsAlertSuggestionsApplyAll({
              userId: params.userId,
              idempotencyKey: pending.idempotencyKey,
            });
          }
          pendingWriteActions.delete(scopeKey);
          return {
            endpoint: pending.endpoint,
            payload: {
              stage: "confirmed",
              summary: pending.summary,
              pending_action_id: pending.id,
              idempotency_key: pending.idempotencyKey,
              result: payload,
            },
            text: formatWriteConfirmedText({
              summary: pending.summary,
              resultPayload: payload,
            }),
          };
        } catch (error) {
          pending.state = "pending";
          throw error;
        }
      },
    }),
  };

  const earningsUpcomingGet: AnyAgentTool = {
    name: toolNames.earningsUpcomingGet,
    label: "Gesahni Earnings Upcoming",
    description: "Read-only upcoming earnings from Gesahni bridge.",
    parameters: GesahniEarningsSchema,
    execute: createSafeExecute<GesahniEarningsParams>({
      toolName: toolNames.earningsUpcomingGet,
      run: async (raw) => {
        const params = resolveEarningsParams(raw, fallbackUserId);
        const payload = await buildService().earningsUpcomingGet({
          userId: params.userId,
          days: params.days,
          symbols: params.symbols,
        });
        return {
          endpoint: "/v1/bridge/earnings/upcoming",
          payload,
          text: formatEarnings(payload),
        };
      },
    }),
  };

  const portfolioGet: AnyAgentTool = {
    name: toolNames.portfolioGet,
    label: "Gesahni Portfolio",
    description: "Read-only portfolio from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.portfolioGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().portfolioGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/portfolio",
          payload,
          text: formatPortfolio(payload),
        };
      },
    }),
  };

  const optionsPositionsGet: AnyAgentTool = {
    name: toolNames.optionsPositionsGet,
    label: "Gesahni Options Positions",
    description: "Read-only options positions from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.optionsPositionsGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().optionsPositionsGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/options/positions",
          payload,
          text: formatOptionsPositions(payload),
        };
      },
    }),
  };

  const optionsWatchRulesGet: AnyAgentTool = {
    name: toolNames.optionsWatchRulesGet,
    label: "Gesahni Options Watch Rules",
    description: "Read-only options watch rules from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.optionsWatchRulesGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().optionsWatchRulesGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/options/watch_rules",
          payload,
          text: formatOptionsWatchRules(payload),
        };
      },
    }),
  };

  const optionsStatusGet: AnyAgentTool = {
    name: toolNames.optionsStatusGet,
    label: "Gesahni Options Status",
    description: "Read-only options status from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.optionsStatusGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().optionsStatusGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/options/status",
          payload,
          text: formatOptionsStatus(payload),
        };
      },
    }),
  };

  const optionsAlertSuggestionsGet: AnyAgentTool = {
    name: toolNames.optionsAlertSuggestionsGet,
    label: "Gesahni Options Alert Suggestions",
    description: "Read-only options alert suggestions from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.optionsAlertSuggestionsGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().optionsAlertSuggestionsGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/options/alert_suggestions",
          payload,
          text: formatOptionsAlertSuggestions(payload),
        };
      },
    }),
  };

  const optionsWatchRuleEventsGet: AnyAgentTool = {
    name: toolNames.optionsWatchRuleEventsGet,
    label: "Gesahni Watch Rule Events",
    description: "Read-only watch rule events from Gesahni bridge.",
    parameters: GesahniIdSchema,
    execute: createSafeExecute<GesahniIdParams>({
      toolName: toolNames.optionsWatchRuleEventsGet,
      run: async (raw) => {
        const params = resolveIdParams(raw, fallbackUserId);
        const payload = await buildService().optionsWatchRuleEventsGet({
          userId: params.userId,
          id: params.id,
        });
        return {
          endpoint: `/v1/bridge/options/watch_rules/${encodeURIComponent(params.id)}/events`,
          payload,
          text: formatWatchRuleEvents(payload),
        };
      },
    }),
  };

  const optionsChainSnapshotGet: AnyAgentTool = {
    name: toolNames.optionsChainSnapshotGet,
    label: "Gesahni Chain Snapshot",
    description: "Read-only options chain snapshot from Gesahni bridge.",
    parameters: GesahniSymbolSchema,
    execute: createSafeExecute<GesahniSymbolParams>({
      toolName: toolNames.optionsChainSnapshotGet,
      run: async (raw) => {
        const params = resolveSymbolParams(raw, fallbackUserId);
        const payload = await buildService().optionsChainSnapshotGet({
          userId: params.userId,
          symbol: params.symbol,
        });
        return {
          endpoint: "/v1/bridge/options/chain_snapshot",
          payload,
          text: formatChainSnapshot(payload, params.symbol),
        };
      },
    }),
  };

  const optionsQuotesBatchGet: AnyAgentTool = {
    name: toolNames.optionsQuotesBatchGet,
    label: "Gesahni Quotes Batch",
    description: "Read-only batched quotes from Gesahni bridge.",
    parameters: GesahniSymbolsBatchSchema,
    execute: createSafeExecute<GesahniSymbolsBatchParams>({
      toolName: toolNames.optionsQuotesBatchGet,
      run: async (raw) => {
        const params = resolveSymbolsBatchParams(raw, fallbackUserId);
        const payload = await buildService().optionsQuotesBatchGet({
          userId: params.userId,
          symbols: params.symbols,
        });
        return {
          endpoint: "/v1/bridge/options/quotes_batch",
          payload,
          text: formatQuotesBatch(payload),
        };
      },
    }),
  };

  const stockQuoteGet: AnyAgentTool = {
    name: toolNames.stockQuoteGet,
    label: "Gesahni Stock Quote",
    description: "Read-only single-symbol stock quote from Gesahni bridge.",
    parameters: GesahniSymbolSchema,
    execute: createSafeExecute<GesahniSymbolParams>({
      toolName: toolNames.stockQuoteGet,
      run: async (raw) => {
        const params = resolveSymbolParams(raw, fallbackUserId);
        const payload = await buildService().stockQuoteGet({
          userId: params.userId,
          symbol: params.symbol,
        });
        return {
          endpoint: "/v1/bridge/stock/quote",
          payload,
          text: formatQuote(payload),
        };
      },
    }),
  };

  const earningsCoverageGet: AnyAgentTool = {
    name: toolNames.earningsCoverageGet,
    label: "Gesahni Earnings Coverage",
    description: "Read-only earnings coverage from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.earningsCoverageGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().earningsCoverageGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/earnings/coverage",
          payload,
          text: formatEarningsCoverage(payload),
        };
      },
    }),
  };

  const earningsRemindersDueGet: AnyAgentTool = {
    name: toolNames.earningsRemindersDueGet,
    label: "Gesahni Earnings Reminders Due",
    description: "Read-only due earnings reminders from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.earningsRemindersDueGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().earningsRemindersDueGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/earnings/reminders/due",
          payload,
          text: formatEarningsReminders("Due", payload),
        };
      },
    }),
  };

  const earningsRemindersSentGet: AnyAgentTool = {
    name: toolNames.earningsRemindersSentGet,
    label: "Gesahni Earnings Reminders Sent",
    description: "Read-only sent earnings reminders from Gesahni bridge.",
    parameters: GesahniReadSchema,
    execute: createSafeExecute<GesahniReadParams>({
      toolName: toolNames.earningsRemindersSentGet,
      run: async (raw) => {
        const params = resolveReadParams(raw, fallbackUserId);
        const payload = await buildService().earningsRemindersSentGet({ userId: params.userId });
        return {
          endpoint: "/v1/bridge/earnings/reminders/sent",
          payload,
          text: formatEarningsReminders("Sent", payload),
        };
      },
    }),
  };

  const alertDeliveriesGet: AnyAgentTool = {
    name: toolNames.alertDeliveriesGet,
    label: "Gesahni Alert Deliveries",
    description: "Read-only alert delivery history from Gesahni bridge.",
    parameters: GesahniAlertDeliveriesSchema,
    execute: createSafeExecute<GesahniAlertDeliveriesParams>({
      toolName: toolNames.alertDeliveriesGet,
      run: async (raw) => {
        const params = resolveAlertDeliveriesParams(raw, fallbackUserId);
        const payload = await buildService().alertDeliveriesGet({
          userId: params.userId,
          alertId: params.alertId,
        });
        return {
          endpoint: `/v1/bridge/alerts/${encodeURIComponent(params.alertId)}/deliveries`,
          payload,
          text: formatAlertDeliveries(payload),
        };
      },
    }),
  };

  return {
    watchlistGet,
    watchlistAdd,
    watchlistRemove,
    positionsGet,
    marketSummaryGet,
    alertsGet,
    alertCreate,
    alertUpdate,
    alertDelete,
    optionsWatchRuleCreate,
    optionsWatchRuleUpdate,
    optionsWatchRuleDelete,
    optionsAlertSuggestionApply,
    optionsAlertSuggestionsApplyAll,
    writeConfirm,
    earningsUpcomingGet,
    portfolioGet,
    optionsPositionsGet,
    optionsWatchRulesGet,
    optionsStatusGet,
    optionsAlertSuggestionsGet,
    optionsWatchRuleEventsGet,
    optionsChainSnapshotGet,
    optionsQuotesBatchGet,
    stockQuoteGet,
    earningsCoverageGet,
    earningsRemindersDueGet,
    earningsRemindersSentGet,
    alertDeliveriesGet,
  };
}
