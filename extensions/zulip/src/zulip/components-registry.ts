import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../../src/config/paths.js";
import { createAsyncLock, writeJsonAtomic } from "../../../../src/infra/json-files.js";
import { normalizeAccountId } from "../../../../src/routing/session-key.js";

export type ZulipComponentEntry = {
  /** Unique button ID (e.g. "btn_abc123") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Button style hint */
  style: string;
  /** Session key for routing the callback */
  sessionKey: string;
  /** Agent ID that owns this component */
  agentId: string;
  /** Zulip account ID */
  accountId: string;
  /** Optional logical callback payload */
  callbackData?: string;
  /** Zulip message ID the widget was attached to */
  messageId?: number;
  /** Canonical Zulip target for follow-up replies (stream/topic or dm ids). */
  replyTo?: string;
  /** Chat type for the originating widget conversation. */
  chatType?: "channel" | "direct";
  /** If true, entry is not consumed on resolve (reusable button) */
  reusable?: boolean;
  /** Restrict to specific Zulip user IDs */
  allowedUsers?: number[];
  createdAt?: number;
  expiresAt?: number;
};

export type StoredZulipComponentEntry = Omit<ZulipComponentEntry, "createdAt" | "expiresAt"> & {
  createdAtMs: number;
  expiresAtMs?: number;
  state: "active" | "consumed";
  consumedAtMs?: number;
};

export type ZulipComponentClaimResult =
  | { kind: "ok"; entry: StoredZulipComponentEntry }
  | { kind: "unauthorized"; entry: StoredZulipComponentEntry }
  | { kind: "missing" | "expired" | "consumed" };

type StoredZulipComponentRegistryFile = {
  version: 1;
  entries: Record<string, StoredZulipComponentEntry>;
};

const DEFAULT_COMPONENT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STORE_VERSION = 1;

function normalizeTimestamp(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : fallback;
}

function normalizePositiveOptionalNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function normalizeAllowedUsers(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const ids = raw
    .map((value) => (typeof value === "number" ? value : Number.parseInt(String(value), 10)))
    .filter((value) => Number.isFinite(value) && value > 0);
  return ids.length > 0 ? Array.from(new Set(ids)) : undefined;
}

function isExpired(entry: { expiresAtMs?: number }, now: number): boolean {
  return typeof entry.expiresAtMs === "number" && entry.expiresAtMs <= now;
}

function toStoredEntry(
  entry: ZulipComponentEntry,
  now: number,
  ttlMs: number,
  messageId?: number,
  callbackExpiresAtMs?: number,
): StoredZulipComponentEntry {
  const createdAtMs = normalizeTimestamp(entry.createdAt, now);
  const expiresAtMs =
    normalizePositiveOptionalNumber(callbackExpiresAtMs) ??
    normalizePositiveOptionalNumber(entry.expiresAt) ??
    createdAtMs + ttlMs;
  return {
    id: entry.id,
    label: entry.label,
    style: entry.style,
    sessionKey: entry.sessionKey,
    agentId: entry.agentId,
    accountId: normalizeAccountId(entry.accountId),
    callbackData: entry.callbackData,
    messageId: normalizePositiveOptionalNumber(messageId ?? entry.messageId),
    replyTo: entry.replyTo,
    chatType: entry.chatType,
    reusable: entry.reusable,
    allowedUsers: normalizeAllowedUsers(entry.allowedUsers),
    createdAtMs,
    expiresAtMs,
    state: "active",
  };
}

function readStoredEntry(raw: unknown, now: number): StoredZulipComponentEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const label = typeof entry.label === "string" ? entry.label : "";
  const style = typeof entry.style === "string" ? entry.style : "primary";
  const sessionKey = typeof entry.sessionKey === "string" ? entry.sessionKey.trim() : "";
  const agentId = typeof entry.agentId === "string" ? entry.agentId.trim() : "";
  const accountId = normalizeAccountId(entry.accountId);
  if (!id || !label || !sessionKey || !agentId) {
    return null;
  }
  const createdAtMs = normalizeTimestamp(entry.createdAtMs, now);
  const expiresAtMs = normalizePositiveOptionalNumber(entry.expiresAtMs);
  return {
    id,
    label,
    style,
    sessionKey,
    agentId,
    accountId,
    callbackData: typeof entry.callbackData === "string" ? entry.callbackData : undefined,
    messageId: normalizePositiveOptionalNumber(entry.messageId),
    replyTo: typeof entry.replyTo === "string" ? entry.replyTo : undefined,
    chatType: entry.chatType === "direct" ? "direct" : entry.chatType === "channel" ? "channel" : undefined,
    reusable: typeof entry.reusable === "boolean" ? entry.reusable : undefined,
    allowedUsers: normalizeAllowedUsers(entry.allowedUsers),
    createdAtMs,
    expiresAtMs,
    state: entry.state === "consumed" ? "consumed" : "active",
    consumedAtMs: normalizePositiveOptionalNumber(entry.consumedAtMs),
  };
}

function resolveStorePath(accountId: string): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "zulip", `components-${normalizeAccountId(accountId)}.json`);
}

class ZulipComponentRegistry {
  readonly accountId: string;
  private readonly storePath: string;
  private readonly entriesById = new Map<string, StoredZulipComponentEntry>();
  private readonly persistLock = createAsyncLock();
  private loadPromise: Promise<void> | null = null;

  constructor(accountId: string) {
    this.accountId = normalizeAccountId(accountId);
    this.storePath = resolveStorePath(this.accountId);
  }

  async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk();
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const now = Date.now();
    let changed = false;
    try {
      if (!fs.existsSync(this.storePath)) {
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as StoredZulipComponentRegistryFile;
      if (raw?.version !== STORE_VERSION || !raw.entries || typeof raw.entries !== "object") {
        return;
      }
      for (const [id, value] of Object.entries(raw.entries)) {
        const entry = readStoredEntry(value, now);
        if (!entry) {
          changed = true;
          continue;
        }
        if (entry.accountId !== this.accountId) {
          changed = true;
          continue;
        }
        if (isExpired(entry, now)) {
          changed = true;
          continue;
        }
        this.entriesById.set(id, entry);
      }
    } catch {
      // Start empty on read failure; do not crash monitor startup.
      return;
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.persistLock(async () => {
      const entries: Record<string, StoredZulipComponentEntry> = {};
      for (const [id, entry] of this.entriesById) {
        entries[id] = entry;
      }
      const payload: StoredZulipComponentRegistryFile = {
        version: STORE_VERSION,
        entries,
      };
      try {
        await writeJsonAtomic(this.storePath, payload, {
          mode: 0o600,
          trailingNewline: true,
          ensureDirMode: 0o700,
        });
      } catch {
        // Keep in-memory registry alive if persistence fails.
      }
    });
  }

  async registerEntries(params: {
    entries: ZulipComponentEntry[];
    ttlMs?: number;
    messageId?: number;
    callbackExpiresAtMs?: number;
  }): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    for (const [id, entry] of this.entriesById) {
      if (isExpired(entry, now)) {
        this.entriesById.delete(id);
      }
    }
    const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
    for (const entry of params.entries) {
      const stored = toStoredEntry(
        entry,
        now,
        ttlMs,
        params.messageId,
        params.callbackExpiresAtMs,
      );
      this.entriesById.set(stored.id, stored);
    }
    await this.persist();
  }

  async claimEntry(params: { id: string; senderId: number }): Promise<ZulipComponentClaimResult> {
    await this.ensureLoaded();
    const entry = this.entriesById.get(params.id);
    if (!entry) {
      return { kind: "missing" };
    }
    const now = Date.now();
    if (isExpired(entry, now)) {
      this.entriesById.delete(params.id);
      await this.persist();
      return { kind: "expired" };
    }
    if (entry.state === "consumed") {
      return { kind: "consumed" };
    }
    if (entry.allowedUsers?.length && !entry.allowedUsers.includes(params.senderId)) {
      return { kind: "unauthorized", entry };
    }
    return { kind: "ok", entry };
  }

  async consumeMessageEntries(messageId: number): Promise<number> {
    await this.ensureLoaded();
    const now = Date.now();
    let count = 0;
    for (const [id, entry] of this.entriesById) {
      if (entry.messageId !== messageId || entry.state === "consumed") {
        continue;
      }
      this.entriesById.set(id, {
        ...entry,
        state: "consumed",
        consumedAtMs: now,
      });
      count += 1;
    }
    if (count > 0) {
      await this.persist();
    }
    return count;
  }

  async removeMessageEntries(messageId: number): Promise<number> {
    await this.ensureLoaded();
    let count = 0;
    for (const [id, entry] of this.entriesById) {
      if (entry.messageId !== messageId) {
        continue;
      }
      this.entriesById.delete(id);
      count += 1;
    }
    if (count > 0) {
      await this.persist();
    }
    return count;
  }

  async removeEntry(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const deleted = this.entriesById.delete(id);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    await this.ensureLoaded();
    let count = 0;
    for (const [id, entry] of this.entriesById) {
      if (!isExpired(entry, now)) {
        continue;
      }
      this.entriesById.delete(id);
      count += 1;
    }
    if (count > 0) {
      await this.persist();
    }
    return count;
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    if (this.entriesById.size === 0) {
      return;
    }
    this.entriesById.clear();
    await this.persist();
  }

  getEntryForTesting(id: string): StoredZulipComponentEntry | undefined {
    return this.entriesById.get(id);
  }
}

const registriesByAccountId = new Map<string, ZulipComponentRegistry>();

function getRegistry(accountId?: string): ZulipComponentRegistry {
  const normalized = normalizeAccountId(accountId);
  const existing = registriesByAccountId.get(normalized);
  if (existing) {
    return existing;
  }
  const created = new ZulipComponentRegistry(normalized);
  registriesByAccountId.set(normalized, created);
  return created;
}

export async function loadZulipComponentRegistry(accountId?: string): Promise<void> {
  await getRegistry(accountId).ensureLoaded();
}

export async function registerZulipComponentEntries(params: {
  entries: ZulipComponentEntry[];
  ttlMs?: number;
  messageId?: number;
  callbackExpiresAtMs?: number;
}): Promise<void> {
  const entry = params.entries[0];
  if (!entry) {
    return;
  }
  await getRegistry(entry.accountId).registerEntries(params);
}

export async function claimZulipComponentEntry(params: {
  accountId?: string;
  id: string;
  senderId: number;
}): Promise<ZulipComponentClaimResult> {
  return await getRegistry(params.accountId).claimEntry({ id: params.id, senderId: params.senderId });
}

export async function consumeZulipComponentMessageEntries(params: {
  accountId?: string;
  messageId: number;
}): Promise<number> {
  return await getRegistry(params.accountId).consumeMessageEntries(params.messageId);
}

export async function removeZulipComponentMessageEntries(params: {
  accountId?: string;
  messageId: number;
}): Promise<number> {
  return await getRegistry(params.accountId).removeMessageEntries(params.messageId);
}

export async function removeZulipComponentEntry(id: string, accountId?: string): Promise<boolean> {
  if (accountId) {
    return await getRegistry(accountId).removeEntry(id);
  }
  let deleted = false;
  for (const registry of registriesByAccountId.values()) {
    deleted = (await registry.removeEntry(id)) || deleted;
  }
  return deleted;
}

export async function clearZulipComponentEntries(accountId?: string): Promise<void> {
  if (accountId) {
    await getRegistry(accountId).clear();
    return;
  }
  await Promise.all([...registriesByAccountId.values()].map((registry) => registry.clear()));
}

export const __testing = {
  getRegistryForAccount(accountId?: string) {
    return getRegistry(accountId);
  },
  resetRegistries() {
    registriesByAccountId.clear();
  },
};
