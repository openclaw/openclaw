import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const DISCORD_COMPONENT_ENTRIES_KEY = Symbol.for("openclaw.discord.componentEntries");
const DISCORD_MODAL_ENTRIES_KEY = Symbol.for("openclaw.discord.modalEntries");

const DISCORD_COMPONENT_REGISTRY_FILE =
  process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE ??
  join(homedir(), ".openclaw", "cache", "discord-component-registry.json");
const REGISTRY_FILE_VERSION = 1;

type PersistedRegistryFile = {
  version: number;
  components: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
};

let componentEntries: Map<string, DiscordComponentEntry> | undefined;
let modalEntries: Map<string, DiscordModalEntry> | undefined;
let componentRegistryLoaded = false;

function getComponentEntriesStore(): Map<string, DiscordComponentEntry> {
  componentEntries ??= resolveGlobalMap<string, DiscordComponentEntry>(
    DISCORD_COMPONENT_ENTRIES_KEY,
  );
  return componentEntries;
}

function getModalEntriesStore(): Map<string, DiscordModalEntry> {
  modalEntries ??= resolveGlobalMap<string, DiscordModalEntry>(DISCORD_MODAL_ENTRIES_KEY);
  return modalEntries;
}

function isExpired(entry: { expiresAt?: number }, now: number) {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}

function normalizeEntryTimestamps<T extends { createdAt?: number; expiresAt?: number }>(
  entry: T,
  now: number,
  ttlMs: number,
): T {
  const createdAt = entry.createdAt ?? now;
  const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
  return { ...entry, createdAt, expiresAt };
}

function isRegistryEntryRecord(entry: unknown): entry is { id: string } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof (entry as { id: unknown }).id === "string" &&
    (entry as { id: string }).id.trim().length > 0
  );
}

function loadPersistedEntries<T extends { id: string; createdAt?: number; expiresAt?: number }>(
  rawEntries: unknown,
  store: Map<string, T>,
  now: number,
): boolean {
  if (!Array.isArray(rawEntries)) {
    return false;
  }
  let changed = false;
  for (const rawEntry of rawEntries) {
    if (!isRegistryEntryRecord(rawEntry)) {
      changed = true;
      continue;
    }
    const normalized = normalizeEntryTimestamps(rawEntry as T, now, DEFAULT_COMPONENT_TTL_MS);
    if (isExpired(normalized, now)) {
      changed = true;
      continue;
    }
    store.set(normalized.id, normalized);
  }
  return changed;
}

function persistComponentRegistry(): void {
  try {
    mkdirSync(dirname(DISCORD_COMPONENT_REGISTRY_FILE), { recursive: true });
    const payload: PersistedRegistryFile = {
      version: REGISTRY_FILE_VERSION,
      components: [...getComponentEntriesStore().values()],
      modals: [...getModalEntriesStore().values()],
    };
    writeFileSync(DISCORD_COMPONENT_REGISTRY_FILE, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.warn(
      `discord component registry persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function loadPersistedComponentRegistry(): void {
  if (componentRegistryLoaded) {
    return;
  }
  componentRegistryLoaded = true;
  if (!existsSync(DISCORD_COMPONENT_REGISTRY_FILE)) {
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(DISCORD_COMPONENT_REGISTRY_FILE, "utf8")) as unknown;
    const parsed =
      typeof raw === "object" && raw !== null
        ? (raw as { components?: unknown; modals?: unknown })
        : undefined;
    const now = Date.now();
    const componentsChanged = loadPersistedEntries(
      parsed?.components,
      getComponentEntriesStore(),
      now,
    );
    const modalsChanged = loadPersistedEntries(parsed?.modals, getModalEntriesStore(), now);
    if (componentsChanged || modalsChanged) {
      persistComponentRegistry();
    }
  } catch (err) {
    console.warn(
      `discord component registry load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getComponentEntries(): Map<string, DiscordComponentEntry> {
  loadPersistedComponentRegistry();
  return getComponentEntriesStore();
}

function getModalEntries(): Map<string, DiscordModalEntry> {
  loadPersistedComponentRegistry();
  return getModalEntriesStore();
}

function registerEntries<
  T extends { id: string; messageId?: string; createdAt?: number; expiresAt?: number },
>(
  entries: T[],
  store: Map<string, T>,
  params: { now: number; ttlMs: number; messageId?: string },
): void {
  for (const entry of entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      params.now,
      params.ttlMs,
    );
    store.set(entry.id, normalized);
  }
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
  if (isExpired(entry, now)) {
    store.delete(params.id);
    persistComponentRegistry();
    return null;
  }
  if (params.consume !== false) {
    store.delete(params.id);
    persistComponentRegistry();
  }
  return entry;
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  registerEntries(params.entries, getComponentEntries(), {
    now,
    ttlMs,
    messageId: params.messageId,
  });
  registerEntries(params.modals, getModalEntries(), { now, ttlMs, messageId: params.messageId });
  persistComponentRegistry();
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  return resolveEntry(getComponentEntries(), params);
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  return resolveEntry(getModalEntries(), params);
}

export function clearDiscordComponentEntries(): void {
  getComponentEntries().clear();
  getModalEntries().clear();
  persistComponentRegistry();
}
