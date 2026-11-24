export const DEFAULT_INTENT_COOLDOWN_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTENT_MAX_FIRES = 3;
export const DEFAULT_INTENT_EXPIRY_MS = 90 * 24 * 60 * 60_000;
export const INTENT_INJECTION_MAX_COUNT = 3;
export const INTENT_INJECTION_MAX_CHARS = 1_200;

export type StandingIntentStatus = "pending" | "armed" | "fired" | "done" | "cancelled" | "expired";

/** Structured location condition for a location-triggered standing intent. */
export type StandingIntentLocationTrigger = {
  /** Exact paired-node id whose location updates are evaluated. */
  nodeId: string;
  /** `enter` fires when the node first moves inside; `exit` when it leaves. */
  direction: "enter" | "exit";
  centerLat: number;
  centerLon: number;
  radiusMeters: number;
};

export type StandingIntentTrigger =
  | { kind: "keywords" }
  | { kind: "location"; location: StandingIntentLocationTrigger };

export type StandingIntent = {
  id: string;
  description: string;
  triggerKeywords: string[];
  triggerEmbedding: string | null;
  trigger: StandingIntentTrigger;
  deliveryTarget: string | null;
  scope: IntentScope;
  channelScope: string | null;
  senderScope: string | null;
  creatorSender: string | null;
  status: StandingIntentStatus;
  expiresAt: number;
  maxFires: number;
  fireCount: number;
  cooldownSeconds: number;
  lastFiredAt: number | null;
  createdAt: number;
  sourceSessionId: string | null;
};

export type StandingIntentRow = {
  id: string;
  description: string;
  trigger_keywords: string;
  trigger_embedding: string | null;
  trigger_kind: "keywords" | "location" | null;
  location_trigger: string | null;
  delivery_target: string | null;
  last_inside: number | null;
  channel_scope: string | null;
  sender_scope: string | null;
  creator_sender: string | null;
  status: StandingIntentStatus;
  expires_at: number;
  max_fires: number;
  fire_count: number;
  cooldown_seconds: number;
  last_fired_at: number | null;
  created_at: number;
  source_session_id: string | null;
};

export type IntentScope = "conversation" | "channel" | "anywhere";

type StoredChannelScope = ["v1", "channel" | "conversation", string, string, string];
type StoredSenderScope = ["v1", string, string, string];

function normalizeScopeIdentity(value: string, field: string, lowercase = false): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is unavailable for this creating turn`);
  }
  return lowercase ? normalized.toLowerCase() : normalized;
}

function normalizeScopeAccountId(accountId: string | undefined): string {
  return accountId?.trim() || "default";
}

export function normalizeCreatorSender(value: string): string {
  const creatorSender = readKnownCreatorSender(value);
  if (!creatorSender) {
    throw new Error("creating sender is unavailable for this turn");
  }
  return creatorSender;
}

export function readKnownCreatorSender(value: string | null): string | null {
  const creatorSender = value?.trim();
  return creatorSender && creatorSender.toLowerCase() !== "unknown" ? creatorSender : null;
}

export function encodeStandingIntentChannelScope(params: {
  scope: Exclude<IntentScope, "anywhere">;
  provider: string;
  accountId?: string;
  conversationId?: string;
}): string {
  const provider = normalizeScopeIdentity(params.provider, "channel identity", true);
  const identity =
    params.scope === "channel"
      ? provider
      : normalizeScopeIdentity(params.conversationId ?? "", "conversation identity");
  return JSON.stringify([
    "v1",
    params.scope,
    provider,
    normalizeScopeAccountId(params.accountId),
    identity,
  ] satisfies StoredChannelScope);
}

export function encodeStandingIntentSenderScope(params: {
  provider: string;
  accountId?: string;
  senderId: string;
}): string {
  return JSON.stringify([
    "v1",
    normalizeScopeIdentity(params.provider, "channel identity", true),
    normalizeScopeAccountId(params.accountId),
    normalizeScopeIdentity(params.senderId, "sender identity"),
  ] satisfies StoredSenderScope);
}

function parseStoredScope(value: string | null, length: number): string[] | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === length &&
      parsed[0] === "v1" &&
      parsed.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function parseStoredChannelScope(value: string | null): {
  scope: IntentScope;
  identity: string | null;
} {
  const parsed = parseStoredScope(value, 5);
  if (parsed && (parsed[1] === "channel" || parsed[1] === "conversation")) {
    return { scope: parsed[1], identity: parsed[4]! };
  }
  // Standing-intent storage is unreleased. Untagged rows are not a compatibility
  // contract and must fail closed rather than collapsing provider/conversation scopes.
  return { scope: "anywhere", identity: null };
}

export function parseStoredLocationTrigger(
  value: string | null,
): StandingIntentLocationTrigger | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).nodeId === "string" &&
      ((parsed as Record<string, unknown>).nodeId as string).trim() &&
      ((parsed as Record<string, unknown>).direction === "enter" ||
        (parsed as Record<string, unknown>).direction === "exit") &&
      typeof (parsed as Record<string, unknown>).centerLat === "number" &&
      Number.isFinite((parsed as Record<string, unknown>).centerLat) &&
      typeof (parsed as Record<string, unknown>).centerLon === "number" &&
      Number.isFinite((parsed as Record<string, unknown>).centerLon) &&
      typeof (parsed as Record<string, unknown>).radiusMeters === "number" &&
      Number.isFinite((parsed as Record<string, unknown>).radiusMeters) &&
      ((parsed as Record<string, unknown>).radiusMeters as number) > 0
    ) {
      return {
        nodeId: ((parsed as Record<string, unknown>).nodeId as string).trim(),
        direction: (parsed as Record<string, unknown>).direction as "enter" | "exit",
        centerLat: (parsed as Record<string, unknown>).centerLat as number,
        centerLon: (parsed as Record<string, unknown>).centerLon as number,
        radiusMeters: (parsed as Record<string, unknown>).radiusMeters as number,
      };
    }
  } catch {}
  return null;
}

export function encodeStoredLocationTrigger(trigger: StandingIntentLocationTrigger): string {
  return JSON.stringify({
    v: 1,
    nodeId: trigger.nodeId,
    direction: trigger.direction,
    centerLat: trigger.centerLat,
    centerLon: trigger.centerLon,
    radiusMeters: trigger.radiusMeters,
  });
}

/** Great-circle distance in meters between two WGS84 points. */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const radius = 6_371_000;
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type LocationFireDecision = {
  /** Observed inside-state after this fix (null stays the previous value when ambiguous). */
  inside: 0 | 1 | null;
  /** True only on a definite enter/exit transition against the previous state. */
  shouldFire: boolean;
};

/**
 * Deterministic fence decision for one fix. The accuracy circle must
 * resolve the boundary unambiguously: `distance + accuracy` fully inside or
 * `distance - accuracy` fully outside; ambiguous fixes hold the previous
 * state. The first fix only establishes the baseline — a transition is
 * required before any fire, so arming inside (or outside) an exit (or
 * enter) fence cannot fire on its own before a real crossing.
 */
export function decideLocationFire(params: {
  trigger: StandingIntentLocationTrigger;
  previousInside: number | null;
  lat: number;
  lon: number;
  accuracyMeters: number;
}): LocationFireDecision {
  const distance = haversineMeters(
    { lat: params.trigger.centerLat, lon: params.trigger.centerLon },
    { lat: params.lat, lon: params.lon },
  );
  const definitelyInside = distance + params.accuracyMeters <= params.trigger.radiusMeters;
  const definitelyOutside = distance - params.accuracyMeters >= params.trigger.radiusMeters;
  const previous = params.previousInside === 1 ? 1 : params.previousInside === 0 ? 0 : null;
  if (definitelyInside) {
    // Direction-gated crossings: an enter fence fires on the 0→1 transition
    // — including the first inside fix when armed from afar (previousInside =
    // null), since an arrival fence exists to notify on arrival. An exit
    // fence NEVER fires on an inside fix: an arrival after an outside
    // baseline (previous = 0) only establishes the inside baseline that a
    // later real exit fires on. Without this gate an exit fence armed from
    // outside fires "leaving" on the user's arrival (verified live
    // 2026-11-16: two "left home" notifications fired while arriving home).
    return {
      inside: 1,
      shouldFire: params.trigger.direction === "enter" && (previous === 0 || previous === null),
    };
  }
  if (definitelyOutside) {
    // Mirror of the inside gate: only an exit fence fires on the 1→0
    // transition. An enter fence baselined inside never fires on leaving —
    // "notify on arrival" does not mean "notify when I go away again"
    // (verified live 2026-11-13: a Göteborg arrival fence fired at 06:33 on
    // the user's morning departure).
    return {
      inside: 0,
      shouldFire: params.trigger.direction === "exit" && previous === 1,
    };
  }
  return { inside: previous, shouldFire: false };
}

export function rowToIntent(row: StandingIntentRow): StandingIntent {
  const channelScope = parseStoredChannelScope(row.channel_scope);
  const locationTrigger =
    row.trigger_kind === "location" ? parseStoredLocationTrigger(row.location_trigger) : null;
  return {
    id: row.id,
    description: row.description,
    triggerKeywords: parseStoredTriggerKeywords(row.trigger_keywords),
    triggerEmbedding: row.trigger_embedding,
    trigger: locationTrigger
      ? { kind: "location", location: locationTrigger }
      : { kind: "keywords" },
    deliveryTarget: row.delivery_target,
    scope: channelScope.scope,
    channelScope: channelScope.identity,
    senderScope: parseStoredScope(row.sender_scope, 4)?.[3] ?? null,
    creatorSender: readKnownCreatorSender(row.creator_sender),
    status: row.status,
    expiresAt: row.expires_at,
    maxFires: row.max_fires,
    fireCount: row.fire_count,
    cooldownSeconds: row.cooldown_seconds,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    sourceSessionId: row.source_session_id,
  };
}

export function parseStoredTriggerKeywords(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
      : [];
  } catch {
    return [];
  }
}

function tokenizeNormalizedIntentText(text: string): string[] {
  return text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

/** Scripts written without spaces between words; `unicode61` tokenizes a whole run as one token. */
const UNSPACED_SCRIPT_TERM =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function needsLiteralIntentCandidates(promptText: string): boolean {
  return UNSPACED_SCRIPT_TERM.test(promptText);
}

/** Unspaced-script terms match literally; other terms retain whole-word boundaries. */
export function triggerKeywordMatchesPrompt(
  keyword: string,
  promptTokens: ReadonlySet<string>,
  promptText: string,
): boolean {
  const terms = tokenizeNormalizedIntentText(keyword.toLowerCase().normalize("NFC"));
  return (
    terms.length > 0 &&
    terms.every((term) =>
      UNSPACED_SCRIPT_TERM.test(term) ? promptText.includes(term) : promptTokens.has(term),
    )
  );
}

export type StandingIntentMatchInput = {
  promptTokens: string[];
  promptText: string;
  ftsQuery: import("openclaw/plugin-sdk/database-engine-worker-runtime").TextQuery;
  channelScopes: string[];
  senderScope?: string;
  nowMs?: number;
};

export function prepareStandingIntentMatch(params: {
  prompt: string;
  channel?: string;
  provider?: string;
  accountId?: string;
  senderId?: string;
  nowMs?: number;
}): StandingIntentMatchInput | undefined {
  const promptText = params.prompt.toLowerCase().normalize("NFC");
  const promptTokens = [...new Set(tokenizeNormalizedIntentText(promptText))];
  if (promptTokens.length === 0) {
    return undefined;
  }
  const channel = params.channel?.trim() || undefined;
  const provider = params.provider?.trim().toLowerCase() || undefined;
  const senderId = params.senderId?.trim() || undefined;
  const channelScopes: string[] = [];
  if (provider) {
    for (const scope of ["channel", "conversation"] as const) {
      if (scope === "conversation" && !channel) {
        continue;
      }
      channelScopes.push(
        encodeStandingIntentChannelScope({
          scope,
          provider,
          accountId: params.accountId,
          conversationId: channel,
        }),
      );
    }
  }
  const storedSenderScope =
    provider && senderId
      ? encodeStandingIntentSenderScope({
          provider,
          accountId: params.accountId,
          senderId,
        })
      : undefined;
  return {
    promptTokens,
    promptText,
    ftsQuery: { kind: "any", clauses: promptTokens.map((text) => ({ kind: "phrase", text })) },
    channelScopes,
    senderScope: storedSenderScope,
    nowMs: params.nowMs,
  };
}

export type StandingIntentOperations = {
  create: { input: StandingIntentRow; output: StandingIntent };
  list: { input: { status?: StandingIntentStatus; nowMs?: number }; output: StandingIntent[] };
  sweep: { input: { nowMs?: number }; output: void };
  cancel: { input: { id: string }; output: StandingIntent | null };
  match: { input: StandingIntentMatchInput; output: StandingIntent[] };
  locationFire: {
    input: LocationFireInput;
    output: LocationFireResult;
  };
};

/** Validated location fix evaluated against armed location intents. */
export type LocationFireInput = {
  nodeId: string;
  lat: number;
  lon: number;
  accuracyMeters: number;
  nowMs?: number;
};

export type LocationFireResult = {
  fired: StandingIntent[];
  /** Armed location intents evaluated for this fix (matches before any state change). */
  evaluated: number;
};

export type StandingIntentWorkerOperations = {
  [Key in keyof StandingIntentOperations]: {
    input: StandingIntentOperations[Key]["input"];
    output: {
      value: StandingIntentOperations[Key]["output"];
      nextDueAt: number | null;
    };
  };
};

function renderStandingIntentContext(intents: StandingIntent[]): string {
  const lines = intents.map((intent) => {
    const createdDate = new Date(intent.createdAt).toISOString().slice(0, 10);
    return `Standing intent (created ${createdDate}): ${intent.description}`;
  });
  return `<standing_intents>\n${lines.join("\n")}\n</standing_intents>`;
}

export function standingIntentsFitContext(intents: StandingIntent[]): boolean {
  return (
    intents.length <= INTENT_INJECTION_MAX_COUNT &&
    renderStandingIntentContext(intents).length <= INTENT_INJECTION_MAX_CHARS
  );
}

export function buildStandingIntentContext(intents: StandingIntent[]): string | undefined {
  const included: StandingIntent[] = [];
  for (const intent of intents.slice(0, INTENT_INJECTION_MAX_COUNT)) {
    if (!standingIntentsFitContext([...included, intent])) {
      continue;
    }
    included.push(intent);
  }
  return included.length > 0 ? renderStandingIntentContext(included) : undefined;
}

export function isEligibleStandingIntentTurn(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  chatId?: string;
}): boolean {
  if (ctx.trigger !== "user" || (!ctx.sessionKey && !ctx.sessionId)) {
    return false;
  }
  const provider = ctx.messageProvider?.trim().toLowerCase();
  return provider === "webchat" || Boolean(ctx.channelId?.trim() || ctx.chatId?.trim());
}
