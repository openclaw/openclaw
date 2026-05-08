import { safeParseJsonWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "openclaw/plugin-sdk/zod";

const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;
const NOSTR_PLUGIN_ID = "nostr";
export const NOSTR_BUS_STATE_NAMESPACE = "bus-state";
export const NOSTR_PROFILE_STATE_NAMESPACE = "profile-state";

type _NostrBusStateV1 = {
  version: 1;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
};

type NostrBusState = {
  version: 2;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
  /** Recent processed event IDs for overlap dedupe across restarts */
  recentEventIds: string[];
};

/** Profile publish state (separate from bus state) */
type NostrProfileState = {
  version: 1;
  /** Unix timestamp (seconds) of last successful profile publish */
  lastPublishedAt: number | null;
  /** Event ID of the last published profile */
  lastPublishedEventId: string | null;
  /** Per-relay publish results from last attempt */
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

const NullableFiniteNumberSchema = z.number().finite().nullable().catch(null);
const NostrBusStateV1Schema = z.object({
  version: z.literal(1),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
});

const NostrBusStateSchema = z.object({
  version: z.literal(2),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
  recentEventIds: z
    .array(z.unknown())
    .catch([])
    .transform((ids) => ids.filter((id): id is string => typeof id === "string")),
});

const NostrProfileStateSchema = z.object({
  version: z.literal(1),
  lastPublishedAt: NullableFiniteNumberSchema,
  lastPublishedEventId: z.string().nullable().catch(null),
  lastPublishResults: z
    .record(z.string(), z.enum(["ok", "failed", "timeout"]))
    .nullable()
    .catch(null),
});

const nostrBusStateStore = createPluginStateKeyedStore<NostrBusState>(NOSTR_PLUGIN_ID, {
  namespace: NOSTR_BUS_STATE_NAMESPACE,
  maxEntries: 1_000,
});

const nostrProfileStateStore = createPluginStateKeyedStore<NostrProfileState>(NOSTR_PLUGIN_ID, {
  namespace: NOSTR_PROFILE_STATE_NAMESPACE,
  maxEntries: 1_000,
});

export function normalizeNostrStateAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

export function parseNostrBusStateJson(raw: string): NostrBusState | null {
  const parsedV2 = safeParseJsonWithSchema(NostrBusStateSchema, raw);
  if (parsedV2) {
    return parsedV2;
  }

  const parsedV1 = safeParseJsonWithSchema(NostrBusStateV1Schema, raw);
  if (!parsedV1) {
    return null;
  }

  // Back-compat: v1 state files
  return {
    version: 2,
    lastProcessedAt: parsedV1.lastProcessedAt,
    gatewayStartedAt: parsedV1.gatewayStartedAt,
    recentEventIds: [],
  };
}

function normalizeNostrBusStateValue(value: unknown): NostrBusState | null {
  const parsedV2 = NostrBusStateSchema.safeParse(value);
  if (parsedV2.success) {
    return parsedV2.data;
  }
  const parsedV1 = NostrBusStateV1Schema.safeParse(value);
  if (!parsedV1.success) {
    return null;
  }
  return {
    version: STORE_VERSION,
    lastProcessedAt: parsedV1.data.lastProcessedAt,
    gatewayStartedAt: parsedV1.data.gatewayStartedAt,
    recentEventIds: [],
  };
}

export async function readNostrBusState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrBusState | null> {
  try {
    return normalizeNostrBusStateValue(
      await nostrBusStateStore.lookup(normalizeNostrStateAccountId(params.accountId)),
    );
  } catch {
    return null;
  }
}

export async function writeNostrBusState(params: {
  accountId?: string;
  lastProcessedAt: number;
  gatewayStartedAt: number;
  recentEventIds?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrBusState = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    recentEventIds: (params.recentEventIds ?? []).filter((x): x is string => typeof x === "string"),
  };
  await nostrBusStateStore.register(normalizeNostrStateAccountId(params.accountId), payload);
}

/**
 * Determine the `since` timestamp for subscription.
 * Returns the later of: lastProcessedAt or gatewayStartedAt (both from disk),
 * falling back to `now` for fresh starts.
 */
export function computeSinceTimestamp(
  state: NostrBusState | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!state) {
    return nowSec;
  }

  // Use the most recent timestamp we have
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t): t is number => t !== null && t > 0,
  );

  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}

// ============================================================================
// Profile State Management
// ============================================================================

export function parseNostrProfileStateJson(raw: string): NostrProfileState | null {
  return safeParseJsonWithSchema(NostrProfileStateSchema, raw);
}

function normalizeNostrProfileStateValue(value: unknown): NostrProfileState | null {
  const parsed = NostrProfileStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readNostrProfileState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrProfileState | null> {
  try {
    return normalizeNostrProfileStateValue(
      await nostrProfileStateStore.lookup(normalizeNostrStateAccountId(params.accountId)),
    );
  } catch {
    return null;
  }
}

export async function writeNostrProfileState(params: {
  accountId?: string;
  lastPublishedAt: number;
  lastPublishedEventId: string;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const payload: NostrProfileState = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults,
  };
  await nostrProfileStateStore.register(normalizeNostrStateAccountId(params.accountId), payload);
}
