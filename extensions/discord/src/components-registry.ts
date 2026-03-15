import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;

// Use globalThis singletons to survive Rolldown chunk splitting.
// Without this, registering in one chunk and looking up in another fails. Refs #40923.
const COMPONENT_ENTRIES_KEY = Symbol.for("openclaw.discordComponentEntries");
const MODAL_ENTRIES_KEY = Symbol.for("openclaw.discordModalEntries");

type GlobalWithEntries = typeof globalThis & {
  [COMPONENT_ENTRIES_KEY]?: Map<string, DiscordComponentEntry>;
  [MODAL_ENTRIES_KEY]?: Map<string, DiscordModalEntry>;
};

const g = globalThis as GlobalWithEntries;
if (!g[COMPONENT_ENTRIES_KEY]) {
  g[COMPONENT_ENTRIES_KEY] = new Map<string, DiscordComponentEntry>();
}
if (!g[MODAL_ENTRIES_KEY]) {
  g[MODAL_ENTRIES_KEY] = new Map<string, DiscordModalEntry>();
}
const componentEntries = g[COMPONENT_ENTRIES_KEY];
const modalEntries = g[MODAL_ENTRIES_KEY];

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

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  for (const entry of params.entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      now,
      ttlMs,
    );
    componentEntries.set(entry.id, normalized);
  }
  for (const modal of params.modals) {
    const normalized = normalizeEntryTimestamps(
      { ...modal, messageId: params.messageId ?? modal.messageId },
      now,
      ttlMs,
    );
    modalEntries.set(modal.id, normalized);
  }
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  const entry = componentEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    componentEntries.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    componentEntries.delete(params.id);
  }
  return entry;
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  const entry = modalEntries.get(params.id);
  if (!entry) {
    return null;
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    modalEntries.delete(params.id);
    return null;
  }
  if (params.consume !== false) {
    modalEntries.delete(params.id);
  }
  return entry;
}

export function clearDiscordComponentEntries(): void {
  componentEntries.clear();
  modalEntries.clear();
}
