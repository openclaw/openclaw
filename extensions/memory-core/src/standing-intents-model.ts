export const DEFAULT_INTENT_COOLDOWN_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTENT_MAX_FIRES = 3;
export const DEFAULT_INTENT_EXPIRY_MS = 90 * 24 * 60 * 60_000;
export const INTENT_INJECTION_MAX_COUNT = 3;
export const INTENT_INJECTION_MAX_CHARS = 1_200;

export type StandingIntentStatus = "pending" | "armed" | "fired" | "done" | "cancelled" | "expired";

export type StandingIntent = {
  id: string;
  description: string;
  triggerKeywords: string[];
  triggerEmbedding: string | null;
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

export function rowToIntent(row: StandingIntentRow): StandingIntent {
  const channelScope = parseStoredChannelScope(row.channel_scope);
  return {
    id: row.id,
    description: row.description,
    triggerKeywords: parseStoredTriggerKeywords(row.trigger_keywords),
    triggerEmbedding: row.trigger_embedding,
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

export function tokenizeIntentText(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export type StandingIntentMatchInput = {
  promptTokens: string[];
  ftsQuery: string;
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
  const promptTokens = [...new Set(tokenizeIntentText(params.prompt))];
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
    ftsQuery: promptTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "),
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
};

export type StandingIntentWorkerOperations = {
  [Key in keyof StandingIntentOperations]: {
    input: StandingIntentOperations[Key]["input"];
    output:
      | { kind: "schema-prepared" }
      | { kind: "result"; value: StandingIntentOperations[Key]["output"] };
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
