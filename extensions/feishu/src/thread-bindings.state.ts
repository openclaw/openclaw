import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FEISHU_THREAD_BINDINGS_VERSION,
  FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  type FeishuThreadBindingRecord,
  type PersistedFeishuThreadBindingsPayload,
} from "./thread-bindings.types.js";

// ---------------------------------------------------------------------------
// globalThis state (shared across ESM / jiti loader paths)
// ---------------------------------------------------------------------------

type FeishuThreadBindingsGlobalState = {
  bindingsByKey: Map<string, FeishuThreadBindingRecord>;
  bindingsBySession: Map<string, Set<string>>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
  lastPersistedAtMs: number;
};

const STATE_KEY = "__openclawFeishuThreadBindingsState";

function createGlobalState(): FeishuThreadBindingsGlobalState {
  return {
    bindingsByKey: new Map(),
    bindingsBySession: new Map(),
    persistByAccountId: new Map(),
    loadedBindings: false,
    lastPersistedAtMs: 0,
  };
}

function resolveGlobalState(): FeishuThreadBindingsGlobalState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: FeishuThreadBindingsGlobalState };
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = createGlobalState();
  }
  return g[STATE_KEY];
}

const STATE = resolveGlobalState();

export const BINDINGS_BY_KEY = STATE.bindingsByKey;
export const BINDINGS_BY_SESSION = STATE.bindingsBySession;

// ---------------------------------------------------------------------------
// Binding key helpers
// ---------------------------------------------------------------------------

export function toBindingKey(accountId: string, chatId: string, rootId: string): string {
  return `${accountId}:${chatId}:${rootId}`;
}

export function toConversationId(chatId: string, rootId: string): string {
  return `${chatId}:${rootId}`;
}

export function parseConversationId(
  conversationId: string,
): { chatId: string; rootId: string } | null {
  const idx = conversationId.indexOf(":");
  if (idx < 1 || idx === conversationId.length - 1) return null;
  return { chatId: conversationId.slice(0, idx), rootId: conversationId.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Session key indexing
// ---------------------------------------------------------------------------

function linkSession(targetSessionKey: string, bindingKey: string): void {
  const key = targetSessionKey.trim();
  if (!key) return;
  const set = BINDINGS_BY_SESSION.get(key) ?? new Set<string>();
  set.add(bindingKey);
  BINDINGS_BY_SESSION.set(key, set);
}

function unlinkSession(targetSessionKey: string, bindingKey: string): void {
  const key = targetSessionKey.trim();
  if (!key) return;
  const set = BINDINGS_BY_SESSION.get(key);
  if (!set) return;
  set.delete(bindingKey);
  if (set.size === 0) BINDINGS_BY_SESSION.delete(key);
}

// ---------------------------------------------------------------------------
// Record CRUD
// ---------------------------------------------------------------------------

export function setBindingRecord(record: FeishuThreadBindingRecord): void {
  const key = toBindingKey(record.accountId, record.chatId, record.rootId);
  const previous = BINDINGS_BY_KEY.get(key);
  if (previous) {
    unlinkSession(previous.targetSessionKey, key);
  }
  BINDINGS_BY_KEY.set(key, record);
  linkSession(record.targetSessionKey, key);
}

export function removeBindingRecord(bindingKey: string): FeishuThreadBindingRecord | null {
  const existing = BINDINGS_BY_KEY.get(bindingKey);
  if (!existing) return null;
  BINDINGS_BY_KEY.delete(bindingKey);
  unlinkSession(existing.targetSessionKey, bindingKey);
  return existing;
}

export function resolveBindingKeysForSession(params: {
  targetSessionKey: string;
  accountId?: string;
}): string[] {
  const set = BINDINGS_BY_SESSION.get(params.targetSessionKey.trim());
  if (!set) return [];
  if (!params.accountId) return [...set];
  return [...set].filter((key) => key.startsWith(`${params.accountId}:`));
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

export function resolveThreadBindingsPath(): string {
  return path.join(resolveStateDirFromEnv(), "feishu", "thread-bindings.json");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

function shouldPersistAnyAccount(): boolean {
  for (const enabled of STATE.persistByAccountId.values()) {
    if (enabled) return true;
  }
  return false;
}

export function saveBindingsToDisk(params: { force?: boolean; minIntervalMs?: number } = {}): void {
  if (!params.force && !shouldPersistAnyAccount()) return;
  const minIntervalMs = params.minIntervalMs ?? FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS;
  const now = Date.now();
  if (
    !params.force &&
    minIntervalMs > 0 &&
    STATE.lastPersistedAtMs > 0 &&
    now - STATE.lastPersistedAtMs < minIntervalMs
  ) {
    return;
  }
  const bindings: Record<string, FeishuThreadBindingRecord> = {};
  for (const [key, record] of BINDINGS_BY_KEY.entries()) {
    bindings[key] = { ...record };
  }
  const payload: PersistedFeishuThreadBindingsPayload = {
    version: FEISHU_THREAD_BINDINGS_VERSION,
    bindings,
  };
  const filePath = resolveThreadBindingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
  STATE.lastPersistedAtMs = now;
}

export function ensureBindingsLoaded(): void {
  if (STATE.loadedBindings) return;
  STATE.loadedBindings = true;
  BINDINGS_BY_KEY.clear();
  BINDINGS_BY_SESSION.clear();

  const filePath = resolveThreadBindingsPath();
  let raw: PersistedFeishuThreadBindingsPayload | null = null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    raw = JSON.parse(content) as PersistedFeishuThreadBindingsPayload;
  } catch {
    // File missing or malformed — start fresh
  }
  if (!raw || typeof raw !== "object" || raw.version !== FEISHU_THREAD_BINDINGS_VERSION) {
    return;
  }
  if (!raw.bindings || typeof raw.bindings !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(raw.bindings)) {
    if (!entry || typeof entry !== "object") continue;
    if (!entry.accountId || !entry.chatId || !entry.rootId || !entry.targetSessionKey) continue;
    setBindingRecord(entry as FeishuThreadBindingRecord);
  }
}

export function setPersistEnabled(accountId: string, enabled: boolean): void {
  STATE.persistByAccountId.set(accountId, enabled);
}

export function resetForTests(): void {
  BINDINGS_BY_KEY.clear();
  BINDINGS_BY_SESSION.clear();
  STATE.persistByAccountId.clear();
  STATE.loadedBindings = false;
  STATE.lastPersistedAtMs = 0;
}
