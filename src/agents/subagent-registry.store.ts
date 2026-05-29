import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { readStringValue } from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PersistedSubagentRegistryV1 = {
  version: 1;
  runs: Record<string, LegacySubagentRunRecord>;
};

type PersistedSubagentRegistryV2 = {
  version: 2;
  runs: Record<string, PersistedSubagentRunRecord>;
};

type PersistedSubagentRegistry = PersistedSubagentRegistryV1 | PersistedSubagentRegistryV2;

const REGISTRY_VERSION = 2 as const;
const MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES = 32;

export type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
export type ReadonlySubagentRunRecord = DeepReadonly<SubagentRunRecord>;

export type SubagentRegistryDiskReadSnapshot = {
  readonly source: "subagent-registry-disk";
  readonly diskSignature: string | null;
  readonly runsById: ReadonlyMap<string, ReadonlySubagentRunRecord>;
};

type PersistedSubagentRunRecord = SubagentRunRecord;

type RegistryCacheEntry = {
  signature: string;
  runs: Map<string, SubagentRunRecord>;
  readonlySnapshot?: SubagentRegistryDiskReadSnapshot;
};

type LoadedRegistryRead = {
  signature: string;
  runs: Map<string, SubagentRunRecord>;
};

type LegacySubagentRunRecord = PersistedSubagentRunRecord & {
  announceCompletedAt?: unknown;
  announceHandled?: unknown;
  requesterChannel?: unknown;
  requesterAccountId?: unknown;
};

class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #inner: Map<K, V>;

  constructor(entries?: Iterable<readonly [K, V]>) {
    this.#inner = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#inner.size;
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }

  get(key: K): V | undefined {
    return this.#inner.get(key);
  }

  has(key: K): boolean {
    return this.#inner.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#inner.entries();
  }

  keys(): MapIterator<K> {
    return this.#inner.keys();
  }

  values(): MapIterator<V> {
    return this.#inner.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#inner.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

const registryReadCache = new Map<string, RegistryCacheEntry>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (!value || typeof value !== "object") {
    return value as DeepReadonly<T>;
  }
  if (seen.has(value)) {
    return value as DeepReadonly<T>;
  }
  seen.add(value);
  const record = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    deepFreeze(record[key], seen);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function cloneSubagentRunRecord(entry: SubagentRunRecord): SubagentRunRecord {
  return structuredClone(entry);
}

export function cloneReadonlySubagentRunRecord(
  entry: SubagentRunRecord | ReadonlySubagentRunRecord,
): ReadonlySubagentRunRecord {
  return deepFreeze(structuredClone(entry));
}

function cloneSubagentRunMap(
  runs: ReadonlyMap<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs].map(([runId, entry]) => [runId, cloneSubagentRunRecord(entry)]));
}

export function createReadonlySubagentRunMap(
  entries: Iterable<readonly [string, ReadonlySubagentRunRecord]>,
): ReadonlyMap<string, ReadonlySubagentRunRecord> {
  return new ImmutableReadonlyMap(entries);
}

function createReadonlySubagentRunMapFromMutable(
  runs: ReadonlyMap<string, SubagentRunRecord>,
): ReadonlyMap<string, ReadonlySubagentRunRecord> {
  return createReadonlySubagentRunMap(
    [...runs].map(([runId, entry]) => [runId, cloneReadonlySubagentRunRecord(entry)] as const),
  );
}

function touchCachedRegistryRead(pathname: string, cached: RegistryCacheEntry): RegistryCacheEntry {
  registryReadCache.delete(pathname);
  registryReadCache.set(pathname, cached);
  return cached;
}

function setCachedRegistryRead(
  pathname: string,
  signature: string,
  runs: Map<string, SubagentRunRecord>,
): RegistryCacheEntry {
  const entry: RegistryCacheEntry = { signature, runs: cloneSubagentRunMap(runs) };
  registryReadCache.delete(pathname);
  registryReadCache.set(pathname, entry);
  if (registryReadCache.size <= MAX_SUBAGENT_REGISTRY_READ_CACHE_ENTRIES) {
    return entry;
  }
  const oldestKey = registryReadCache.keys().next().value;
  if (typeof oldestKey === "string") {
    registryReadCache.delete(oldestKey);
  }
  return entry;
}

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveSubagentRegistryPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "subagents", "runs.json");
}

function readRegistryFile(pathname: string, signature: string): LoadedRegistryRead {
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return { signature, runs: new Map() };
  }
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== 1 && record.version !== 2) {
    return { signature, runs: new Map() };
  }
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") {
    return { signature, runs: new Map() };
  }
  const out = new Map<string, SubagentRunRecord>();
  const isLegacy = record.version === 1;
  let migrated = false;
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as LegacySubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    const legacyCompletedAt =
      isLegacy && typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    const cleanupCompletedAt =
      typeof typed.cleanupCompletedAt === "number" ? typed.cleanupCompletedAt : legacyCompletedAt;
    const cleanupHandled =
      typeof typed.cleanupHandled === "boolean"
        ? typed.cleanupHandled
        : isLegacy
          ? Boolean(typed.announceHandled ?? cleanupCompletedAt)
          : undefined;
    const requesterOrigin = normalizeDeliveryContext(
      typed.requesterOrigin ?? {
        channel: readStringValue(typed.requesterChannel),
        accountId: readStringValue(typed.requesterAccountId),
      },
    );
    const childSessionKey = readStringValue(typed.childSessionKey)?.trim() ?? "";
    const requesterSessionKey = readStringValue(typed.requesterSessionKey)?.trim() ?? "";
    const controllerSessionKey =
      readStringValue(typed.controllerSessionKey)?.trim() || requesterSessionKey;
    if (!childSessionKey || !requesterSessionKey) {
      continue;
    }
    const {
      announceCompletedAt: _announceCompletedAt,
      announceHandled: _announceHandled,
      requesterChannel: _channel,
      requesterAccountId: _accountId,
      ...rest
    } = typed;
    out.set(
      runId,
      normalizeSubagentRunState({
        ...rest,
        childSessionKey,
        requesterSessionKey,
        controllerSessionKey,
        requesterOrigin,
        cleanupCompletedAt,
        cleanupHandled,
        spawnMode: typed.spawnMode === "session" ? "session" : "run",
      }),
    );
    if (isLegacy) {
      migrated = true;
    }
  }
  if (!migrated) {
    return { signature, runs: out };
  }
  try {
    saveSubagentRegistryToDisk(out);
    return { signature: statRegistryFileSignature(pathname) ?? signature, runs: out };
  } catch {
    // ignore migration write failures
    return { signature, runs: out };
  }
}

function getCachedRegistryRead(pathname: string, signature: string): RegistryCacheEntry {
  const cached = registryReadCache.get(pathname);
  if (cached?.signature === signature) {
    return touchCachedRegistryRead(pathname, cached);
  }
  const loaded = readRegistryFile(pathname, signature);
  const loadedCached = registryReadCache.get(pathname);
  if (loadedCached?.signature === loaded.signature) {
    return touchCachedRegistryRead(pathname, loadedCached);
  }
  return setCachedRegistryRead(pathname, loaded.signature, loaded.runs);
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord>;
export function loadSubagentRegistryFromDisk(options: {
  clone: false;
}): ReadonlyMap<string, ReadonlySubagentRunRecord>;
export function loadSubagentRegistryFromDisk(options?: {
  clone?: boolean;
}): Map<string, SubagentRunRecord> | ReadonlyMap<string, ReadonlySubagentRunRecord> {
  if (options?.clone === false) {
    return getSubagentRegistryDiskReadSnapshot().runsById;
  }
  const pathname = resolveSubagentRegistryPath();
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
    return new Map();
  }
  return cloneSubagentRunMap(getCachedRegistryRead(pathname, signature).runs);
}

export function getSubagentRegistryDiskReadSnapshot(): SubagentRegistryDiskReadSnapshot {
  const pathname = resolveSubagentRegistryPath();
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
    return Object.freeze({
      source: "subagent-registry-disk" as const,
      diskSignature: null,
      runsById: createReadonlySubagentRunMap([]),
    });
  }
  const cached = getCachedRegistryRead(pathname, signature);
  if (!cached.readonlySnapshot) {
    cached.readonlySnapshot = Object.freeze({
      source: "subagent-registry-disk" as const,
      diskSignature: cached.signature,
      runsById: createReadonlySubagentRunMapFromMutable(cached.runs),
    });
  }
  return cached.readonlySnapshot;
}

export function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = normalizeSubagentRunState(cloneSubagentRunRecord(entry));
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
  const signature = statRegistryFileSignature(pathname);
  if (signature === null) {
    registryReadCache.delete(pathname);
  } else {
    setCachedRegistryRead(pathname, signature, runs);
  }
}

function statRegistryFileSignature(pathname: string): string | null {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
