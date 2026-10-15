import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  discordComponentRegistryState,
  type DiscordRegistryStore,
  type PersistedDiscordRegistryEntry,
} from "./components-registry-state.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";
import { getOptionalDiscordRuntime } from "./runtime.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const PERSISTENT_COMPONENT_NAMESPACE = "discord.components";
const PERSISTENT_MODAL_NAMESPACE = "discord.modals";
const PERSISTENT_REGISTRY_MAX_ENTRIES = 500;

function formatRegistryError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: formatRegistryErrorValue(error) };
  }
  const details: Record<string, unknown> = {};
  const appendError = (prefix: "error" | "errorCause", entry: Error) => {
    details[prefix] = String(entry);
    details[`${prefix}Name`] = entry.name;
    details[`${prefix}Message`] = entry.message;
    if (entry.stack) {
      details[`${prefix}Stack`] = entry.stack;
    }
  };
  appendError("error", error);
  const cause = error.cause;
  if (cause instanceof Error) {
    appendError("errorCause", cause);
  } else if (cause !== undefined) {
    details.errorCause = formatRegistryErrorValue(cause);
  }
  return details;
}

const reportPersistentComponentRegistryError = createPluginStateErrorReporter(
  getOptionalDiscordRuntime,
  "discord",
  "component-registry-state",
  "Discord persistent component registry state failed",
  formatRegistryError,
);

function formatRegistryErrorValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function disablePersistentComponentRegistry(error: unknown): void {
  discordComponentRegistryState.persistentRegistryDisabled = true;
  discordComponentRegistryState.persistentComponentStore = undefined;
  discordComponentRegistryState.persistentModalStore = undefined;
  reportPersistentComponentRegistryError(error);
}

function openPersistentRegistryStore<T extends { id: string }>(
  cached: DiscordRegistryStore<T> | undefined,
  namespace: string,
): DiscordRegistryStore<T> | undefined {
  if (discordComponentRegistryState.persistentRegistryDisabled) {
    return undefined;
  }
  if (cached) {
    return cached;
  }
  const runtime = getOptionalDiscordRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedDiscordRegistryEntry<T>>({
      namespace,
      maxEntries: PERSISTENT_REGISTRY_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_COMPONENT_TTL_MS,
    });
  } catch (error) {
    disablePersistentComponentRegistry(error);
    return undefined;
  }
}

function getPersistentComponentStore(): DiscordRegistryStore<DiscordComponentEntry> | undefined {
  return (discordComponentRegistryState.persistentComponentStore = openPersistentRegistryStore(
    discordComponentRegistryState.persistentComponentStore,
    PERSISTENT_COMPONENT_NAMESPACE,
  ));
}

function getPersistentModalStore(): DiscordRegistryStore<DiscordModalEntry> | undefined {
  return (discordComponentRegistryState.persistentModalStore = openPersistentRegistryStore(
    discordComponentRegistryState.persistentModalStore,
    PERSISTENT_MODAL_NAMESPACE,
  ));
}

function pruneUndefinedRegistryValues<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(pruneUndefinedRegistryValues) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    result[key] = pruneUndefinedRegistryValues(entry);
  }
  return result as T;
}

function normalizeRegistryEntries<
  T extends { id: string; messageId?: string; createdAt?: number; expiresAt?: number },
>(entries: T[], params: { now: number; ttlMs: number; messageId?: string }): T[] {
  return entries.map((entry) => {
    const createdAt = resolveDateTimestampMs(entry.createdAt, params.now);
    const expiresAt =
      asDateTimestampMs(entry.expiresAt) ??
      resolveExpiresAtMsFromDurationMs(params.ttlMs, { nowMs: createdAt }) ??
      0;
    return { ...entry, messageId: params.messageId ?? entry.messageId, createdAt, expiresAt };
  });
}

function resolveEntry<T extends { expiresAt?: number }>(
  store: Map<string, T>,
  params: { id: string; consume?: boolean },
): T | null {
  const entry = store.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (entry.expiresAt !== undefined && !isFutureDateTimestampMs(entry.expiresAt, { nowMs: now })) {
    store.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    store.delete(params.id);
  }
  return entry;
}

function readPersistedRegistryEntry<T extends { id: string }>(
  persisted: PersistedDiscordRegistryEntry<T> | undefined,
): T | null {
  if (persisted?.version !== 1 || typeof persisted.entry?.id !== "string") {
    return null;
  }
  return persisted.entry;
}

async function registerPersistentRegistryEntries<T extends { id: string }>(params: {
  entries: T[];
  ttlMs: number;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): Promise<void> {
  if (params.entries.length === 0) {
    return;
  }
  const store = params.openStore();
  if (!store) {
    return;
  }
  await Promise.all(
    params.entries.map(async (entry) => {
      try {
        const persistedEntry = pruneUndefinedRegistryValues(entry);
        await store.register(
          entry.id,
          { version: 1, entry: persistedEntry },
          { ttlMs: params.ttlMs },
        );
      } catch (error) {
        disablePersistentComponentRegistry(error);
      }
    }),
  );
}

async function deletePersistentEntry<T extends { id: string }>(params: {
  id: string;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): Promise<void> {
  const store = params.openStore();
  if (!store) {
    return;
  }
  try {
    await store.delete(params.id);
  } catch (error) {
    disablePersistentComponentRegistry(error);
  }
}

function resolveComponentConsumptionIds(entry: DiscordComponentEntry): string[] {
  if (!entry.consumptionGroupId) {
    return [entry.id];
  }
  const ids = entry.consumptionGroupEntryIds?.filter((id) => typeof id === "string" && id) ?? [];
  return ids.length > 0 ? uniqueStrings(ids) : [entry.id];
}

async function resolvePersistentRegistryEntry<T extends { id: string }>(params: {
  id: string;
  consume?: boolean;
  openStore: () => DiscordRegistryStore<T> | undefined;
}): Promise<T | null> {
  const store = params.openStore();
  if (!store) {
    return null;
  }
  try {
    const value =
      params.consume === false ? await store.lookup(params.id) : await store.consume(params.id);
    return readPersistedRegistryEntry(value);
  } catch (error) {
    disablePersistentComponentRegistry(error);
    return null;
  }
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): Promise<void> {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  const entryOptions = { now, ttlMs, messageId: params.messageId };
  const normalizedEntries = normalizeRegistryEntries(params.entries, entryOptions);
  const normalizedModals = normalizeRegistryEntries(params.modals, entryOptions);
  return discordComponentRegistryState.withRegistryLock(async () => {
    for (const entry of normalizedEntries) {
      discordComponentRegistryState.componentEntries.set(entry.id, entry);
    }
    for (const entry of normalizedModals) {
      discordComponentRegistryState.modalEntries.set(entry.id, entry);
    }
    await Promise.all([
      registerPersistentRegistryEntries({
        entries: normalizedEntries,
        ttlMs,
        openStore: getPersistentComponentStore,
      }),
      registerPersistentRegistryEntries({
        entries: normalizedModals,
        ttlMs,
        openStore: getPersistentModalStore,
      }),
    ]);
  });
}

export async function resolveDiscordComponentEntryWithPersistence(params: {
  id: string;
  consume?: boolean;
}): Promise<DiscordComponentEntry | null> {
  // Group membership may only be known after lookup. Keep fallback reads behind
  // the winning consume until every sibling's persistent deletion has settled.
  return discordComponentRegistryState.withRegistryLock(async () => {
    const store = discordComponentRegistryState.componentEntries;
    const inMemory = resolveEntry(store, params);
    const entry =
      inMemory ??
      (await resolvePersistentRegistryEntry({
        ...params,
        openStore: getPersistentComponentStore,
      }));
    if (entry && params.consume !== false) {
      if (inMemory) {
        for (const id of resolveComponentConsumptionIds(entry)) {
          store.delete(id);
        }
      }
      await Promise.all(
        resolveComponentConsumptionIds(entry).map((id) =>
          deletePersistentEntry({ id, openStore: getPersistentComponentStore }),
        ),
      );
    }
    return entry;
  });
}

export async function resolveDiscordModalEntryWithPersistence(params: {
  id: string;
  consume?: boolean;
}): Promise<DiscordModalEntry | null> {
  return discordComponentRegistryState.withRegistryLock(async () => {
    const inMemory = resolveEntry(discordComponentRegistryState.modalEntries, params);
    if (inMemory) {
      if (params.consume !== false) {
        await deletePersistentEntry({ ...params, openStore: getPersistentModalStore });
      }
      return inMemory;
    }
    return await resolvePersistentRegistryEntry({
      ...params,
      openStore: getPersistentModalStore,
    });
  });
}
