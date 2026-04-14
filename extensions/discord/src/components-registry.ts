import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep as pathSep } from "node:path";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000;
const DISCORD_COMPONENT_ENTRIES_KEY = Symbol.for("openclaw.discord.componentEntries");
const DISCORD_MODAL_ENTRIES_KEY = Symbol.for("openclaw.discord.modalEntries");

const REGISTRY_FILE_VERSION = 1;
const MAX_REGISTRY_BYTES = 1_000_000; // 1 MB — prevents unbounded read/parse DoS
const MAX_ENTRIES_PER_TYPE = 10_000; // cap total entries per registry type

// --- Path hardening: validate env-var path stays under the safe base directory ---
function resolveRegistryPath(): string {
  const baseDir = join(homedir(), ".openclaw", "cache");
  const configured = process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE;
  const candidate = configured
    ? resolve(configured)
    : join(baseDir, "discord-component-registry.json");
  const resolvedBase = resolve(baseDir) + pathSep;
  if (!candidate.startsWith(resolvedBase)) {
    throw new Error(
      "OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE must resolve to a path under ~/.openclaw/cache",
    );
  }
  return candidate;
}

let _registryPath: string | undefined;
function getRegistryPath(): string {
  _registryPath ??= resolveRegistryPath();
  return _registryPath;
}

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

function isComponentEntryRecord(entry: unknown): entry is DiscordComponentEntry {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id.trim()) {
    return false;
  }
  if (!["button", "select", "modal-trigger"].includes(e.kind as string)) {
    return false;
  }
  if (e.selectType !== undefined && typeof e.selectType !== "string") {
    return false;
  }
  if (e.options !== undefined && !Array.isArray(e.options)) {
    return false;
  }
  if (e.sessionKey !== undefined && typeof e.sessionKey !== "string") {
    return false;
  }
  if (e.agentId !== undefined && typeof e.agentId !== "string") {
    return false;
  }
  if (e.accountId !== undefined && typeof e.accountId !== "string") {
    return false;
  }
  if (e.allowedUsers !== undefined && !Array.isArray(e.allowedUsers)) {
    return false;
  }
  return true;
}

function isModalEntryRecord(entry: unknown): entry is DiscordModalEntry {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id.trim()) {
    return false;
  }
  if (typeof e.title !== "string") {
    return false;
  }
  if (!Array.isArray(e.fields)) {
    return false;
  }
  if (e.sessionKey !== undefined && typeof e.sessionKey !== "string") {
    return false;
  }
  if (e.agentId !== undefined && typeof e.agentId !== "string") {
    return false;
  }
  if (e.accountId !== undefined && typeof e.accountId !== "string") {
    return false;
  }
  if (e.allowedUsers !== undefined && !Array.isArray(e.allowedUsers)) {
    return false;
  }
  return true;
}

function clampExpiresAt(createdAt: number, expiresAt: number, maxAgeMs: number): number {
  const maxAllowed = createdAt + maxAgeMs;
  return expiresAt > maxAllowed ? maxAllowed : expiresAt;
}

function loadPersistedEntries<T extends { id: string; createdAt?: number; expiresAt?: number }>(
  rawEntries: unknown,
  store: Map<string, T>,
  now: number,
  isValid: (entry: unknown) => entry is T,
): boolean {
  if (!Array.isArray(rawEntries)) {
    return false;
  }
  let changed = false;
  let count = 0;
  for (const rawEntry of rawEntries) {
    if (count++ >= MAX_ENTRIES_PER_TYPE) {
      changed = true;
      break;
    }
    if (!isValid(rawEntry)) {
      changed = true;
      continue;
    }
    // Clamp expiresAt to prevent far-future tampering (issue #3)
    let normalized = normalizeEntryTimestamps(rawEntry, now, DEFAULT_COMPONENT_TTL_MS);
    if (normalized.expiresAt) {
      normalized = {
        ...normalized,
        expiresAt: clampExpiresAt(
          normalized.createdAt ?? now,
          normalized.expiresAt,
          DEFAULT_COMPONENT_TTL_MS,
        ),
      };
    }
    if (isExpired(normalized, now)) {
      changed = true;
      continue;
    }
    store.set(normalized.id, normalized);
  }
  return changed;
}

// Debounce flag: coalesce rapid register/resolve events into a single write
// so that interactive hot paths (button clicks, modal submissions) don't block
// the event loop with synchronous disk I/O on every interaction.
let _persistScheduled = false;
function schedulePersistComponentRegistry(): void {
  if (_persistScheduled) {
    return;
  }
  _persistScheduled = true;
  setImmediate(() => {
    _persistScheduled = false;
    persistComponentRegistry();
  });
}

function persistComponentRegistry(): void {
  const filePath = getRegistryPath();
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedRegistryFile = {
      version: REGISTRY_FILE_VERSION,
      components: [...getComponentEntriesStore().values()],
      modals: [...getModalEntriesStore().values()],
    };
    // Atomic write: temp file + rename, both with restrictive perms (issues #1, #4)
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(tmp, 0o600);
    atomicRename(tmp, filePath);
  } catch (err) {
    console.warn(
      `discord component registry persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function atomicRename(tmp: string, dest: string): void {
  try {
    // On POSIX, rename is atomic per the directory entry level.
    // Node 22+ provides a native `fs.renameSync` which is atomic on same filesystem.
    renameSync(tmp, dest);
  } catch {
    // If rename fails (e.g. cross-device on some POSIX), fall back to direct write.
    // The file already has 0o600 so the permissions are correct either way.
    try {
      const { copyFileSync, unlinkSync } = require("node:fs");
      copyFileSync(tmp, dest);
      unlinkSync(tmp);
    } catch {
      // Best-effort; leave the temp file for manual cleanup.
    }
  }
}

function loadPersistedComponentRegistry(): void {
  if (componentRegistryLoaded) {
    return;
  }
  componentRegistryLoaded = true;
  const filePath = getRegistryPath();
  if (!existsSync(filePath)) {
    return;
  }
  try {
    // DoS guard: reject files larger than MAX_REGISTRY_BYTES (issue #2)
    const st = statSync(filePath);
    if (st.size > MAX_REGISTRY_BYTES) {
      console.warn("discord component registry file too large; ignoring");
      return;
    }
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed =
      typeof raw === "object" && raw !== null
        ? (raw as { version?: unknown; components?: unknown; modals?: unknown })
        : undefined;
    if (parsed?.version !== REGISTRY_FILE_VERSION) {
      return; // unknown version — silently ignore
    }
    const now = Date.now();
    const componentsChanged = loadPersistedEntries(
      parsed?.components,
      getComponentEntriesStore(),
      now,
      isComponentEntryRecord,
    );
    const modalsChanged = loadPersistedEntries(
      parsed?.modals,
      getModalEntriesStore(),
      now,
      isModalEntryRecord,
    );
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
    schedulePersistComponentRegistry();
    return null;
  }
  if (params.consume !== false) {
    store.delete(params.id);
    schedulePersistComponentRegistry();
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
  schedulePersistComponentRegistry();
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
