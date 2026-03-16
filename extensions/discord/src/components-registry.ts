import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const COMPONENT_REGISTRY_FILENAME = "components-registry.json";

const componentEntries = new Map<string, DiscordComponentEntry>();
const modalEntries = new Map<string, DiscordModalEntry>();
let hasLoadedRegistryStore = false;

type DiscordComponentRegistryStore = {
  components: Record<string, DiscordComponentEntry>;
  modals: Record<string, DiscordModalEntry>;
};

function resolveDiscordComponentRegistryPath(): string {
  return path.join(resolveStateDir(), "discord", COMPONENT_REGISTRY_FILENAME);
}

function createEmptyStore(): DiscordComponentRegistryStore {
  return {
    components: {},
    modals: {},
  };
}

function writeStoreAtomically(filePath: string, store: DiscordComponentRegistryStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best-effort
    }
  }
}

function persistRegistryStore(): void {
  writeStoreAtomically(resolveDiscordComponentRegistryPath(), {
    components: Object.fromEntries(componentEntries),
    modals: Object.fromEntries(modalEntries),
  });
}

function readStoreFromDisk(): DiscordComponentRegistryStore {
  try {
    const raw = fs.readFileSync(resolveDiscordComponentRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordComponentRegistryStore> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyStore();
    }
    return {
      components:
        parsed.components && typeof parsed.components === "object" ? parsed.components : {},
      modals: parsed.modals && typeof parsed.modals === "object" ? parsed.modals : {},
    };
  } catch {
    return createEmptyStore();
  }
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

function ensureRegistryStoreLoaded(): void {
  if (hasLoadedRegistryStore) {
    return;
  }
  const store = readStoreFromDisk();
  const now = Date.now();
  componentEntries.clear();
  modalEntries.clear();
  for (const [id, entry] of Object.entries(store.components)) {
    if (isExpired(entry, now)) {
      continue;
    }
    componentEntries.set(id, entry);
  }
  for (const [id, entry] of Object.entries(store.modals)) {
    if (isExpired(entry, now)) {
      continue;
    }
    modalEntries.set(id, entry);
  }
  hasLoadedRegistryStore = true;
}

function resolveEntry<T extends { expiresAt?: number }>(params: {
  entries: Map<string, T>;
  id: string;
  consume?: boolean;
}): T | null {
  ensureRegistryStoreLoaded();
  const entry = params.entries.get(params.id);
  if (!entry) {
    return null;
  }
  if (isExpired(entry, Date.now())) {
    params.entries.delete(params.id);
    persistRegistryStore();
    return null;
  }
  if (params.consume !== false) {
    params.entries.delete(params.id);
    persistRegistryStore();
  }
  return entry;
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  ensureRegistryStoreLoaded();
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
  persistRegistryStore();
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  return resolveEntry({
    entries: componentEntries,
    id: params.id,
    consume: params.consume,
  });
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  return resolveEntry({
    entries: modalEntries,
    id: params.id,
    consume: params.consume,
  });
}

export function clearDiscordComponentEntries(): void {
  componentEntries.clear();
  modalEntries.clear();
  hasLoadedRegistryStore = true;
  persistRegistryStore();
}
