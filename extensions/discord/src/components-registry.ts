import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
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
const MAX_STRING_ARRAY_LEN = 1_000; // cap for options / allowedUsers arrays

// Fields stripped from persisted entries. Routing fields (sessionKey/agentId/
// accountId) and authorization fields (allowedUsers) are ephemeral by design
// and must not be written to disk — an attacker reading the cache must not be
// able to impersonate sessions or bypass allowlists after a gateway restart.
const SENSITIVE_ENTRY_FIELDS = ["sessionKey", "agentId", "accountId", "allowedUsers"] as const;

function stripSensitiveFields<T extends object>(entry: T): T {
  const clone: Record<string, unknown> = { ...entry };
  for (const key of SENSITIVE_ENTRY_FIELDS) {
    delete clone[key];
  }
  return clone as T;
}

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

function isOptionArray(x: unknown): x is Array<{ value: string; label: string }> {
  return (
    Array.isArray(x) &&
    x.length <= MAX_STRING_ARRAY_LEN &&
    x.every(
      (o) =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as { value?: unknown }).value === "string" &&
        typeof (o as { label?: unknown }).label === "string",
    )
  );
}

function isModalFieldRecord(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id.trim()) {
    return false;
  }
  if (typeof e.name !== "string") {
    return false;
  }
  if (typeof e.label !== "string") {
    return false;
  }
  if (typeof e.type !== "string") {
    return false;
  }
  if (e.options !== undefined && !isOptionArray(e.options)) {
    return false;
  }
  return true;
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
  if (e.options !== undefined && !isOptionArray(e.options)) {
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
  if (!Array.isArray(e.fields) || e.fields.length > MAX_STRING_ARRAY_LEN) {
    return false;
  }
  if (!e.fields.every(isModalFieldRecord)) {
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

// Reject symlinks at the destination (CWE-59). Resolving the directory via
// realpathSync and comparing to the expected base protects against attackers
// staging `discord-component-registry.json` as a symlink into `~/.ssh/` etc.
function assertSafeRegistryDestination(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const expectedBase = resolve(join(homedir(), ".openclaw", "cache")) + pathSep;
  const realDir = realpathSync(dir) + pathSep;
  if (!realDir.startsWith(expectedBase)) {
    throw new Error("registry directory escapes ~/.openclaw/cache after realpath");
  }
  if (existsSync(filePath)) {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error("registry file is a symlink; refusing to write");
    }
  }
}

function persistComponentRegistry(): void {
  const filePath = getRegistryPath();
  let tmp: string | undefined;
  let fd: number | undefined;
  try {
    assertSafeRegistryDestination(filePath);
    const payload: PersistedRegistryFile = {
      version: REGISTRY_FILE_VERSION,
      components: [...getComponentEntriesStore().values()].map(stripSensitiveFields),
      modals: [...getModalEntriesStore().values()].map(stripSensitiveFields),
    };
    // Random tmp name + `wx` open prevents clobbering an attacker-prepared
    // file (CWE-59/CWE-362). `wx` fails if the path already exists.
    tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(payload)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, filePath);
    tmp = undefined;
  } catch (err) {
    console.warn(
      `discord component registry persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
    if (tmp !== undefined) {
      try {
        const { unlinkSync } = require("node:fs") as typeof import("node:fs");
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
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
    // Refuse to read through a symlink — an attacker who can stage a symlink
    // inside the cache dir could redirect this read to an arbitrary file.
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      console.warn("discord component registry file is a symlink; ignoring");
      return;
    }
    // DoS guard: reject files larger than MAX_REGISTRY_BYTES
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

function purgeExpired<T extends { expiresAt?: number }>(store: Map<string, T>, now: number): void {
  for (const [id, entry] of store) {
    if (isExpired(entry, now)) {
      store.delete(id);
    }
  }
}

function registerEntries<
  T extends { id: string; messageId?: string; createdAt?: number; expiresAt?: number },
>(
  entries: T[],
  store: Map<string, T>,
  params: { now: number; ttlMs: number; messageId?: string },
): void {
  // Purge expired before inserting so stale entries do not hog the cap and
  // the persisted snapshot only contains live items. Enforces the
  // MAX_ENTRIES_PER_TYPE hard cap on registration paths, not just at load.
  purgeExpired(store, params.now);
  if (store.size + entries.length > MAX_ENTRIES_PER_TYPE) {
    console.warn(
      `discord component registry cap reached (${store.size}/${MAX_ENTRIES_PER_TYPE}); rejecting ${entries.length} new entries`,
    );
    return;
  }
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
