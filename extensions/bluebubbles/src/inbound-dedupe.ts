import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ClaimableDedupe, createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import { tryGetBlueBubblesRuntime } from "./runtime.js";

// BlueBubbles has no sequence/ack in its webhook protocol, and its
// MessagePoller replays its ~1-week lookback window as `new-message` events
// after BB Server restarts or reconnects. Without persistent dedup, the
// gateway can reply to messages that were already handled before a restart
// (see issues #19176, #12053).
//
// TTL matches BB's lookback window so any replay is guaranteed to land on
// a remembered GUID, and the file-backed store survives gateway restarts.
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MEMORY_MAX_SIZE = 5_000;
const FILE_MAX_ENTRIES = 50_000;
const SQLITE_NAMESPACE_PREFIX = "inbound-dedupe";
const SQLITE_CLAIM_LEASE_MS = 30 * 60 * 1_000;
// Cap GUID length so a malformed or hostile payload can't bloat the on-disk
// dedupe file. Real BB GUIDs are short (<64 chars); 512 is generous.
const MAX_GUID_CHARS = 512;

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VITEST || env.NODE_ENV === "test") {
    // Isolate tests from real ~/.openclaw state without sharing across tests.
    // Stable-per-pid so the scoped dedupe test can observe persistence.
    const name = "openclaw-vitest-" + process.pid;
    return path.join(resolvePreferredOpenClawTmpDir(), name);
  }
  // Canonical OpenClaw state dir: honors OPENCLAW_STATE_DIR (with `~` expansion
  // via resolveUserPath), plus legacy/new fallback. Using the shared helper
  // keeps this plugin's persistence aligned with the rest of OpenClaw state.
  return resolveStateDir(env);
}

function resolveLegacyNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "global";
  return path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe", `${safe}.json`);
}

function resolveNamespaceFilePath(namespace: string): string {
  // Keep a readable prefix for operator debugging, but suffix with a short
  // hash of the raw namespace so account IDs that only differ by
  // filesystem-unsafe characters (e.g. "acct/a" vs "acct:a") don't collapse
  // onto the same file.
  const safePrefix = namespace.replace(/[^a-zA-Z0-9_-]/g, "_") || "ns";
  const hash = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 12);
  const dir = path.join(resolveStateDirFromEnv(), "bluebubbles", "inbound-dedupe");
  const newPath = path.join(dir, `${safePrefix}__${hash}.json`);

  // One-time migration: earlier beta shipped `${safe}.json` (no hash).
  // Rename so the upgrade preserves existing dedupe entries instead of
  // starting from an empty file and replaying already-handled messages.
  migrateLegacyDedupeFile(namespace, newPath);

  return newPath;
}

const migratedNamespaces = new Set<string>();

function migrateLegacyDedupeFile(namespace: string, newPath: string): void {
  if (migratedNamespaces.has(namespace)) {
    return;
  }
  migratedNamespaces.add(namespace);
  try {
    const legacyPath = resolveLegacyNamespaceFilePath(namespace);
    if (legacyPath === newPath) {
      return;
    }
    if (!fs.existsSync(legacyPath)) {
      return;
    }
    if (!fs.existsSync(newPath)) {
      fs.renameSync(legacyPath, newPath);
    } else {
      // Both exist: new file is authoritative; remove the stale legacy.
      fs.unlinkSync(legacyPath);
    }
  } catch {
    // Best-effort migration; a missed rename is strictly less harmful
    // than crashing the module load path.
  }
}

function buildPersistentImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
    fileMaxEntries: FILE_MAX_ENTRIES,
    resolveFilePath: resolveNamespaceFilePath,
  });
}

function buildMemoryOnlyImpl(): ClaimableDedupe {
  return createClaimableDedupe({
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
  });
}

type BlueBubblesSqliteDedupeRecord = {
  status: "claimed" | "committed";
  at: number;
};

type BlueBubblesSqliteDedupeStore = {
  register(
    key: string,
    value: BlueBubblesSqliteDedupeRecord,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  registerIfAbsent(
    key: string,
    value: BlueBubblesSqliteDedupeRecord,
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  lookup(key: string): Promise<BlueBubblesSqliteDedupeRecord | undefined>;
  delete(key: string): Promise<boolean>;
};

const sqliteInflightClaims = new Set<string>();
const sqliteStores = new Map<string, BlueBubblesSqliteDedupeStore>();
let impl: ClaimableDedupe = buildPersistentImpl();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isExperimentalPersistentStateEnabled(): boolean {
  const runtime = tryGetBlueBubblesRuntime();
  if (!runtime) {
    return false;
  }
  const cfg = runtime.config.current() as unknown;
  if (!isRecord(cfg)) {
    return false;
  }
  const plugins = cfg.plugins;
  if (!isRecord(plugins)) {
    return false;
  }
  const entries = plugins.entries;
  if (!isRecord(entries)) {
    return false;
  }
  const entry = entries.bluebubbles;
  if (!isRecord(entry)) {
    return false;
  }
  const pluginConfig = entry.config;
  return isRecord(pluginConfig) && pluginConfig.experimentalPersistentState === true;
}

function resolveSqliteNamespace(accountId: string): string {
  const safePrefix = accountId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "account";
  const hash = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 12);
  return `${SQLITE_NAMESPACE_PREFIX}.${safePrefix}_${hash}`;
}

function getSqliteStore(accountId: string): BlueBubblesSqliteDedupeStore {
  const namespace = resolveSqliteNamespace(accountId);
  const existing = sqliteStores.get(namespace);
  if (existing) {
    return existing;
  }
  const runtime = tryGetBlueBubblesRuntime();
  if (!runtime) {
    throw new Error("BlueBubbles runtime not initialized");
  }
  const store = runtime.state.openKeyedStore<BlueBubblesSqliteDedupeRecord>({
    namespace,
    maxEntries: FILE_MAX_ENTRIES,
    maxPluginEntries: FILE_MAX_ENTRIES,
    defaultTtlMs: DEDUP_TTL_MS,
  });
  sqliteStores.set(namespace, store);
  return store;
}

function resolveSqliteScopedClaimKey(accountId: string, guid: string): string {
  return `${accountId}\0${guid}`;
}

function sanitizeGuid(guid: string | undefined | null): string | null {
  const trimmed = guid?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_GUID_CHARS) {
    return null;
  }
  return trimmed;
}

/**
 * Resolve the canonical dedupe key for a BlueBubbles inbound message.
 *
 * Mirrors `monitor-debounce.ts`'s `buildKey`: BlueBubbles sends URL-preview
 * / sticker "balloon" events with a different `messageId` than the text
 * message they belong to, and the debouncer coalesces the two only when
 * both `balloonBundleId` AND `associatedMessageGuid` are present. We gate
 * on the same pair so that regular replies — which also set
 * `associatedMessageGuid` (pointing at the parent message) but have no
 * `balloonBundleId` — are NOT collapsed onto their parent's dedupe key.
 *
 * Known tradeoff: `combineDebounceEntries` clears `balloonBundleId` on
 * merged entries while keeping `associatedMessageGuid`, so a post-merge
 * balloon+text message here will fall back to its `messageId`. A later
 * MessagePoller replay that arrives in a different text-first/balloon-first
 * order could therefore produce a different `messageId` at merge time and
 * bypass this dedupe for that one message. That edge case is strictly
 * narrower than the alternative — which would dedupe every distinct user
 * reply against the same parent GUID and silently drop real messages.
 */
export function resolveBlueBubblesInboundDedupeKey(
  message: Pick<
    NormalizedWebhookMessage,
    "messageId" | "balloonBundleId" | "associatedMessageGuid" | "eventType"
  >,
): string | undefined {
  const balloonBundleId = message.balloonBundleId?.trim();
  const associatedMessageGuid = message.associatedMessageGuid?.trim();
  let base: string | undefined;
  if (balloonBundleId && associatedMessageGuid) {
    base = associatedMessageGuid;
  } else {
    base = message.messageId?.trim() || undefined;
  }
  if (!base) {
    return undefined;
  }
  // `updated-message` events get a distinct key so they are not rejected as
  // duplicates of the already-committed `new-message` for the same GUID.
  // This lets attachment-carrying follow-up webhooks through. (#65430, #52277)
  if (message.eventType === "updated-message") {
    return `${base}:updated`;
  }
  return base;
}

type InboundDedupeClaim =
  | { kind: "claimed"; finalize: () => Promise<void>; release: () => void }
  | { kind: "duplicate" }
  | { kind: "inflight" }
  | { kind: "skip" };

/**
 * Attempt to claim an inbound BlueBubbles message GUID.
 *
 * - `claimed`: caller should process the message, then call `finalize()` on
 *   success (persists the GUID) or `release()` on failure (lets a later
 *   replay try again).
 * - `duplicate`: we've already committed this GUID; caller should drop.
 * - `inflight`: another claim is currently in progress; caller should drop
 *   rather than race.
 * - `skip`: GUID was missing or invalid — caller should continue processing
 *   without dedup (no finalize/release needed).
 */
export async function claimBlueBubblesInboundMessage(params: {
  guid: string | undefined | null;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<InboundDedupeClaim> {
  const normalized = sanitizeGuid(params.guid);
  if (!normalized) {
    return { kind: "skip" };
  }
  if (isExperimentalPersistentStateEnabled()) {
    return claimBlueBubblesSqliteInboundMessage({
      guid: normalized,
      accountId: params.accountId,
      onDiskError: params.onDiskError,
    });
  }

  const claim = await impl.claim(normalized, {
    namespace: params.accountId,
    onDiskError: params.onDiskError,
  });
  if (claim.kind === "duplicate") {
    return { kind: "duplicate" };
  }
  if (claim.kind === "inflight") {
    return { kind: "inflight" };
  }
  return {
    kind: "claimed",
    finalize: async () => {
      await impl.commit(normalized, {
        namespace: params.accountId,
        onDiskError: params.onDiskError,
      });
    },
    release: () => {
      impl.release(normalized, { namespace: params.accountId });
    },
  };
}

async function claimBlueBubblesSqliteInboundMessage(params: {
  guid: string;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<InboundDedupeClaim> {
  const scopedClaimKey = resolveSqliteScopedClaimKey(params.accountId, params.guid);
  if (sqliteInflightClaims.has(scopedClaimKey)) {
    return { kind: "inflight" };
  }
  sqliteInflightClaims.add(scopedClaimKey);
  try {
    const store = getSqliteStore(params.accountId);
    const inserted = await store.registerIfAbsent(
      params.guid,
      { status: "claimed", at: Date.now() },
      { ttlMs: SQLITE_CLAIM_LEASE_MS },
    );
    if (!inserted) {
      sqliteInflightClaims.delete(scopedClaimKey);
      const existing = await store.lookup(params.guid);
      return existing?.status === "claimed" ? { kind: "inflight" } : { kind: "duplicate" };
    }
    return {
      kind: "claimed",
      finalize: async () => {
        try {
          await store.register(
            params.guid,
            { status: "committed", at: Date.now() },
            { ttlMs: DEDUP_TTL_MS },
          );
        } catch (error) {
          params.onDiskError?.(error);
        } finally {
          sqliteInflightClaims.delete(scopedClaimKey);
        }
      },
      release: () => {
        sqliteInflightClaims.delete(scopedClaimKey);
        void store.delete(params.guid).catch(params.onDiskError);
      },
    };
  } catch (error) {
    sqliteInflightClaims.delete(scopedClaimKey);
    params.onDiskError?.(error);
    return claimBlueBubblesFileBackedInboundMessage({
      guid: params.guid,
      accountId: params.accountId,
      onDiskError: params.onDiskError,
    });
  }
}

async function claimBlueBubblesFileBackedInboundMessage(params: {
  guid: string;
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<InboundDedupeClaim> {
  const claim = await impl.claim(params.guid, {
    namespace: params.accountId,
    onDiskError: params.onDiskError,
  });
  if (claim.kind === "duplicate") {
    return { kind: "duplicate" };
  }
  if (claim.kind === "inflight") {
    return { kind: "inflight" };
  }
  return {
    kind: "claimed",
    finalize: async () => {
      await impl.commit(params.guid, {
        namespace: params.accountId,
        onDiskError: params.onDiskError,
      });
    },
    release: () => {
      impl.release(params.guid, { namespace: params.accountId });
    },
  };
}

/**
 * Mark a set of source messageIds as already processed, without going through
 * the `claim()` protocol. Intended for the coalesced-batch case: when the
 * debouncer merges N webhook events into one agent turn, only the primary
 * messageId reaches `claimBlueBubblesInboundMessage`. The remaining source
 * messageIds must still be remembered so a later MessagePoller replay of any
 * single source event is recognized as a duplicate rather than re-processed.
 *
 * Best-effort — disk errors on secondary commits are surfaced via
 * `onDiskError` but never thrown, so a single persistence hiccup cannot block
 * the caller's main finalize path.
 */
export async function commitBlueBubblesCoalescedMessageIds(params: {
  messageIds: readonly string[];
  accountId: string;
  onDiskError?: (error: unknown) => void;
}): Promise<void> {
  for (const raw of params.messageIds) {
    const normalized = sanitizeGuid(raw);
    if (!normalized) {
      continue;
    }
    if (isExperimentalPersistentStateEnabled()) {
      try {
        const store = getSqliteStore(params.accountId);
        await store.registerIfAbsent(
          normalized,
          { status: "committed", at: Date.now() },
          { ttlMs: DEDUP_TTL_MS },
        );
        continue;
      } catch (error) {
        params.onDiskError?.(error);
      }
    }
    await impl.commit(normalized, {
      namespace: params.accountId,
      onDiskError: params.onDiskError,
    });
  }
}

/**
 * Ensure the legacy→hashed dedupe file migration runs and the on-disk
 * store is warmed into memory for the given account. Call before any
 * catchup replay so already-handled GUIDs are recognized even when the
 * file-naming convention changed between versions.
 */
export async function warmupBlueBubblesInboundDedupe(accountId: string): Promise<void> {
  if (isExperimentalPersistentStateEnabled()) {
    getSqliteStore(accountId);
    return;
  }
  // Trigger the migration side-effect inside resolveNamespaceFilePath.
  resolveNamespaceFilePath(accountId);
  await impl.warmup(accountId);
}

/**
 * Reset inbound dedupe state between tests. Installs an in-memory-only
 * implementation so tests do not hit disk, avoiding file-lock timing issues
 * in the webhook flush path.
 */
export function _resetBlueBubblesInboundDedupForTest(): void {
  impl = buildMemoryOnlyImpl();
  sqliteInflightClaims.clear();
  sqliteStores.clear();
}
