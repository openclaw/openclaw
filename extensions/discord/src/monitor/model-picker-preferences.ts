import { normalizeAccountId as normalizeSharedAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";
import {
  buildPreferenceModelKey,
  normalizeModelRef,
  preferenceTimestampMs,
} from "./model-picker-preference-primitives.js";

const DEFAULT_RECENT_LIMIT = 5;
const PREFERENCE_MAX_ENTRIES = 2_000;
let lastPreferenceTimestampMs = 0;
let lastPreferenceOrder = 0;

type ModelPickerPreferencesEntry = {
  scopeKey: string;
  modelRef: string;
  updatedAt: string;
  updatedOrder?: number;
};

function openPreferenceStore(env?: NodeJS.ProcessEnv) {
  return getDiscordRuntime().state.openKeyedStore<ModelPickerPreferencesEntry>({
    namespace: "model-picker-preferences",
    maxEntries: PREFERENCE_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

export type DiscordModelPickerPreferenceScope = {
  accountId?: string;
  guildId?: string;
  userId: string;
};

function buildDiscordModelPickerPreferenceKey(
  scope: DiscordModelPickerPreferenceScope,
): string | null {
  const userId = normalizeOptionalString(scope.userId);
  if (!userId) {
    return null;
  }
  const accountId = normalizeSharedAccountId(scope.accountId);
  const guildId = normalizeOptionalString(scope.guildId);
  return `discord:${accountId}:${guildId ? `guild:${guildId}` : "dm"}:user:${userId}`;
}

function sanitizeStoredPreferenceEntry(value: unknown): ModelPickerPreferencesEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const typedValue = value as {
    scopeKey?: unknown;
    modelRef?: unknown;
    updatedAt?: unknown;
    updatedOrder?: unknown;
  };
  if (typeof typedValue.scopeKey !== "string" || typeof typedValue.modelRef !== "string") {
    return undefined;
  }
  const modelRef = normalizeModelRef(typedValue.modelRef);
  if (!modelRef) {
    return undefined;
  }
  return {
    scopeKey: typedValue.scopeKey,
    modelRef,
    updatedAt: typeof typedValue.updatedAt === "string" ? typedValue.updatedAt : "",
    updatedOrder:
      typeof typedValue.updatedOrder === "number" && Number.isSafeInteger(typedValue.updatedOrder)
        ? typedValue.updatedOrder
        : undefined,
  };
}

function timestampOrder(value?: number): number {
  return value !== undefined && value >= 0 ? value : 0;
}

function scopedPreferenceEntries(
  entries: Array<{ key: string; value: unknown }>,
  scopeKey: string,
) {
  return entries
    .map((entry) => ({ key: entry.key, value: sanitizeStoredPreferenceEntry(entry.value) }))
    .filter(
      (entry): entry is { key: string; value: ModelPickerPreferencesEntry } =>
        entry.value?.scopeKey === scopeKey,
    );
}

function comparePreferenceEntries(
  left: { key: string; value: ModelPickerPreferencesEntry },
  right: { key: string; value: ModelPickerPreferencesEntry },
): number {
  return (
    preferenceTimestampMs(right.value.updatedAt) - preferenceTimestampMs(left.value.updatedAt) ||
    timestampOrder(right.value.updatedOrder) - timestampOrder(left.value.updatedOrder) ||
    left.key.localeCompare(right.key)
  );
}

function nextPreferenceTimestamp(): {
  updatedAt: string;
  updatedOrder: number;
} {
  lastPreferenceTimestampMs = Math.max(Date.now(), lastPreferenceTimestampMs + 1);
  return {
    updatedAt: new Date(lastPreferenceTimestampMs).toISOString(),
    updatedOrder: ++lastPreferenceOrder,
  };
}

export async function readDiscordModelPickerRecentModels(params: {
  scope: DiscordModelPickerPreferenceScope;
  limit?: number;
  allowedModelRefs?: Set<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  if (!key) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
  try {
    const store = openPreferenceStore(params.env);
    const recent = scopedPreferenceEntries(await store.entries(), key)
      .toSorted(comparePreferenceEntries)
      .map((entry) => entry.value.modelRef);
    const visible =
      !params.allowedModelRefs || params.allowedModelRefs.size === 0
        ? recent
        : recent.filter((modelRef) => params.allowedModelRefs?.has(modelRef));
    return [...new Set(visible)].slice(0, limit);
  } catch {
    // Preferences are optional; unavailable history must not fail the model picker.
    return [];
  }
}

export async function recordDiscordModelPickerRecentModel(params: {
  scope: DiscordModelPickerPreferenceScope;
  modelRef: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const key = buildDiscordModelPickerPreferenceKey(params.scope);
  const normalizedModelRef = normalizeModelRef(params.modelRef);
  if (!key || !normalizedModelRef) {
    return;
  }

  try {
    const store = openPreferenceStore(params.env);
    const existingEntries = scopedPreferenceEntries(await store.entries(), key);
    const timestamp = nextPreferenceTimestamp();
    const modelKey = buildPreferenceModelKey(key, normalizedModelRef);
    await store.register(modelKey, {
      scopeKey: key,
      modelRef: normalizedModelRef,
      ...timestamp,
    });
    const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_RECENT_LIMIT, 10));
    const expired = existingEntries
      .filter((entry) => entry.key !== modelKey)
      .toSorted(comparePreferenceEntries)
      .slice(limit - 1);
    await Promise.all(expired.map((entry) => store.delete(entry.key)));
  } catch {
    // Preferences are optional; a failed save must not fail the model command.
  }
}
