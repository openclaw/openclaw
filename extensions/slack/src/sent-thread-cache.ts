import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { STATE_DIR } from "openclaw/plugin-sdk/state-paths";

/**
 * In-memory cache of Slack threads the bot has participated in.
 * Used to auto-respond in threads without requiring @mention after the first reply.
 * Follows a similar TTL pattern to the MS Teams and Telegram sent-message caches.
 *
 * The cache is persisted to disk so that thread participation survives gateway
 * restarts.  Writes are debounced (at most once per PERSIST_DEBOUNCE_MS) and
 * reads happen once on first access.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 5000;

/**
 * Hard cap on the persisted file size. The schema is `Record<string, number>`
 * — with reasonable thread-key lengths (~50 chars) and a 13-digit timestamp
 * value, MAX_ENTRIES * ~80 bytes/entry ≈ 400 KB worst case. We cap at 4 MB
 * to give 10x headroom for unusual key lengths but still hard-fail before
 * a corrupt or malicious file can OOM the gateway via JSON.parse. (Aisle
 * security review on PR #33845, P3.)
 */
const MAX_PERSIST_FILE_BYTES = 4 * 1024 * 1024;

/**
 * File mode for the persist file: owner read/write only. Prevents
 * other users on multi-tenant hosts from reading thread participation
 * (which can leak workspace structure / ID patterns) or writing to it
 * (which would let them poison the cache).
 */
const PERSIST_FILE_MODE = 0o600;

/**
 * Directory mode for the persist file's parent directory: owner-only.
 * Matches PERSIST_FILE_MODE so an attacker on a multi-tenant host can't
 * traverse into the directory to enumerate other persist files or
 * pre-create symlinks to be picked up by atomic-rename. Mirrors the
 * mode the SDK helper uses (gpt-5.5 deep-review P2-D).
 */
const PERSIST_DIR_MODE = 0o700;
const PERSIST_DEBOUNCE_MS = 5_000;
const PERSIST_FILENAME = "slack-thread-participation.json";

/**
 * Keep Slack thread participation shared across bundled chunks so thread
 * auto-reply gating does not diverge between prepare/dispatch call paths.
 */
const SLACK_THREAD_PARTICIPATION_KEY = Symbol.for("openclaw.slackThreadParticipation");
const threadParticipation = resolveGlobalDedupeCache(SLACK_THREAD_PARTICIPATION_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

/** Persistence state shared across module instances via global singleton. */
interface PersistState {
  /** Shadow map for serialization — dedupe cache doesn't expose entries. */
  entries: Map<string, number>;
  hydrated: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Test-only override for the persist file path. Lives on the global
   * singleton (not module-local) so it survives across module instances
   * created by dynamic re-import or bundler code splitting — otherwise
   * tests that exercise re-imported copies of this module would have the
   * override silently lost on the second instance, while in-memory dedupe
   * still works via the shared `entries` map. Disk side effects would
   * then leak into STATE_DIR instead of the per-test temp dir.
   */
  persistPathOverride: string | undefined;
}

const PERSIST_STATE_KEY = Symbol.for("openclaw.slackThreadParticipationPersistState");
const persistState: PersistState =
  ((globalThis as Record<symbol, unknown>)[PERSIST_STATE_KEY] as PersistState) ??
  ((globalThis as Record<symbol, unknown>)[PERSIST_STATE_KEY] = {
    entries: new Map(),
    hydrated: false,
    persistTimer: null,
    persistPathOverride: undefined,
  });

function getPersistPath(): string {
  return persistState.persistPathOverride ?? path.join(STATE_DIR, PERSIST_FILENAME);
}

/** Load persisted entries into both the dedupe cache and the shadow map. */
function hydrateFromDisk(): void {
  if (persistState.hydrated) {
    return;
  }
  persistState.hydrated = true;
  try {
    const filePath = getPersistPath();
    // Bounded parse: stat the file first and refuse to load if it's larger
    // than MAX_PERSIST_FILE_BYTES. This prevents JSON.parse from being used
    // as a memory-exhaustion vector by a corrupt, externally-tampered, or
    // unusually-large persist file. (Aisle security review on PR #33845.)
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_PERSIST_FILE_BYTES) {
      // File is too large — likely corruption or external tampering.
      // Start fresh; the next persist will overwrite atomically with a
      // bounded snapshot.
      return;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, number>;
    // Schema validation: refuse non-object payloads so a future writer
    // that produces an array or scalar can't poison Object.entries below.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return;
    }
    const now = Date.now();
    // Collect valid (key, ts) tuples first, then enforce MAX_ENTRIES by
    // most-recent timestamp before inserting. The 4 MB file cap above
    // permits up to ~250K entries through, which would otherwise blow
    // past the 5K in-memory cap on first load (Aisle medium #1 / opus
    // P2 / gpt-5.5 P2-A review). Sorting DESC by ts and slicing keeps
    // hydration bounded by MAX_ENTRIES regardless of file size up to
    // MAX_PERSIST_FILE_BYTES.
    //
    // Timestamp guard: require ts > 0 && ts <= now in addition to the
    // TTL window. This rejects future timestamps from a crafted persist
    // file or a backwards system-clock jump (gpt-5.5 P2-C / P3-C).
    // Without this guard, a ts of e.g. Number.MAX_SAFE_INTEGER would
    // satisfy now - ts < TTL_MS (the difference underflows or stays
    // negative) and the entry would never expire.
    const candidates: Array<[string, number]> = [];
    for (const [key, ts] of Object.entries(data)) {
      if (
        typeof ts === "number" &&
        Number.isFinite(ts) &&
        ts > 0 &&
        ts <= now &&
        now - ts < TTL_MS
      ) {
        candidates.push([key, ts]);
      }
    }
    if (candidates.length > MAX_ENTRIES) {
      // Sort DESC by ts so we slice to keep the most-recent MAX_ENTRIES.
      candidates.sort((a, b) => b[1] - a[1]);
      candidates.length = MAX_ENTRIES;
    }
    // Sort ASC by ts so Map insertion order matches recency (oldest
    // first). recordSlackThreadParticipation()'s eviction loop relies
    // on `keys().next()` returning the OLDEST entry; without this sort
    // a slice from the DESC branch above would invert the order and the
    // first eviction after hydration would drop the NEWEST entry
    // instead of the oldest (gpt-5.5 P3-B).
    candidates.sort((a, b) => a[1] - b[1]);
    for (const [key, ts] of candidates) {
      // Use check() to insert into the dedupe cache (it returns false for new entries)
      threadParticipation.check(key, ts);
      persistState.entries.set(key, ts);
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
}

/**
 * Synchronously prune expired entries, cap to MAX_ENTRIES, and atomically
 * write to disk. Shared between the debounced timer in schedulePersist()
 * and the test-only flush helper _flushPersist() so any future hardening
 * (write atomicity, file modes, etc.) lives in exactly one place
 * (gpt-5.5 P2-B: previously these two paths drifted independently).
 */
function persistToDisk(): void {
  // Prune expired entries before writing.
  const now = Date.now();
  for (const [key, ts] of persistState.entries) {
    if (now - ts >= TTL_MS) {
      persistState.entries.delete(key);
    }
  }
  // Cap persisted size to MAX_ENTRIES by most-recent timestamp so the
  // on-disk file can't grow beyond the in-memory dedupe cap.
  let entries = Array.from(persistState.entries.entries());
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, MAX_ENTRIES);
    // Re-sort ASC by ts so the on-disk JSON iteration order is
    // oldest-first. This matters because hydration's fast path (file
    // ≤ MAX_ENTRIES, no sort) preserves iteration order into the Map,
    // and the in-memory eviction loop assumes Map insertion order =
    // ts-ASC. Inverting that order would cause post-restart evictions
    // to drop the newest entries instead of the oldest (gpt-5.5 P3-B).
    entries.sort((a, b) => a[1] - b[1]);
  }
  const data = Object.fromEntries(entries);
  const filePath = getPersistPath();
  // mkdirSync is fine to call repeatedly; mode is applied only when the
  // directory is created. 0o700 mirrors the SDK helper and matches the
  // 0o600 file mode (gpt-5.5 P2-D).
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: PERSIST_DIR_MODE });
  // Write atomically via temp file + rename so a mid-write crash
  // can't leave a truncated/corrupt JSON on disk.
  //
  // Security: tmpPath uses randomUUID() (not pid) and flag "wx"
  // (O_CREAT | O_EXCL) to close the symlink-follow window described
  // in CWE-59. A predictable name like ${pid}.tmp combined with the
  // default "w" flag would let an attacker pre-create a symlink at
  // the tmp path pointing to e.g. /etc/passwd, and our truncating
  // write would follow it. "wx" refuses to overwrite existing
  // entries (file or symlink), and randomUUID() removes
  // predictability. Aisle medium #2 / opus P1 / gpt-5.5 P1-B.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), {
    mode: PERSIST_FILE_MODE,
    flag: "wx",
  });
  fs.renameSync(tmpPath, filePath);
}

/** Debounced write of the shadow map to disk. */
function schedulePersist(): void {
  if (persistState.persistTimer) {
    return;
  }
  persistState.persistTimer = setTimeout(() => {
    persistState.persistTimer = null;
    try {
      persistToDisk();
    } catch {
      // Best-effort persistence — don't crash on write failures.
    }
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the event loop open for a debounced persist.
  persistState.persistTimer.unref?.();
}

function makeKey(accountId: string, channelId: string, threadTs: string): string {
  return `${accountId}:${channelId}:${threadTs}`;
}

export function recordSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): void {
  if (!accountId || !channelId || !threadTs) {
    return;
  }
  hydrateFromDisk();
  const key = makeKey(accountId, channelId, threadTs);
  threadParticipation.check(key);
  // Reinsert on update so Map insertion order reflects recency.
  // `Map.set` on an existing key updates the value but keeps the key in
  // its original insertion position; without delete-then-set the
  // insertion-order semantics drift from actual recency, which would
  // matter for any future iteration order-based eviction (clawsweeper
  // review on PR #33845).
  persistState.entries.delete(key);
  persistState.entries.set(key, Date.now());
  // Bound in-memory growth between debounced writes. The pre-existing
  // serialise-time cap protects the on-disk file but did NOT protect
  // memory in busy workspaces accumulating thousands of unique threads
  // between persists. Evict the oldest entries (Map insertion order =
  // recency thanks to delete-then-set above) once we exceed the cap.
  while (persistState.entries.size > MAX_ENTRIES) {
    const oldest = persistState.entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    persistState.entries.delete(oldest);
  }
  schedulePersist();
}

export function hasSlackThreadParticipation(
  accountId: string,
  channelId: string,
  threadTs: string,
): boolean {
  if (!accountId || !channelId || !threadTs) {
    return false;
  }
  hydrateFromDisk();
  return threadParticipation.peek(makeKey(accountId, channelId, threadTs));
}

export function clearSlackThreadParticipationCache(): void {
  threadParticipation.clear();
  persistState.entries.clear();
  if (persistState.persistTimer) {
    clearTimeout(persistState.persistTimer);
    persistState.persistTimer = null;
  }
  try {
    fs.unlinkSync(getPersistPath());
  } catch {
    // Ignore — file may not exist.
  }
}

/**
 * Detect whether we are running in a test environment. Used to gate
 * test-only helpers below so that accidental runtime usage in production
 * (e.g. via deep-import from a buggy plugin) fails loudly instead of
 * silently performing arbitrary filesystem operations. This is
 * defence-in-depth on top of the api.ts barrel which doesn't re-export
 * these helpers; the threat model is accidental misuse, not adversarial
 * plugins (which would have full process access anyway).
 */
function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.OPENCLAW_TEST === "1"
  );
}

/** @internal Flush pending persist timer synchronously (for tests). */
export function _flushPersist(): void {
  if (!isTestEnvironment()) {
    throw new Error(
      "_flushPersist() is a test-only helper and was called outside a test " +
        "environment (NODE_ENV/VITEST/OPENCLAW_TEST not set). This helper performs " +
        "synchronous disk writes and must not be invoked from production code.",
    );
  }
  if (persistState.persistTimer) {
    clearTimeout(persistState.persistTimer);
    persistState.persistTimer = null;
  }
  // Reuse the shared persistToDisk() implementation so test-time and
  // production-time writes can never drift (gpt-5.5 P2-B).
  try {
    persistToDisk();
  } catch {
    // Best-effort.
  }
}

/** @internal Reset all state for tests, optionally setting a custom persist path. */
export function _resetForTests(persistPath?: string): void {
  if (!isTestEnvironment()) {
    throw new Error(
      "_resetForTests() is a test-only helper and was called outside a test " +
        "environment (NODE_ENV/VITEST/OPENCLAW_TEST not set). This helper can " +
        "redirect the persist file path and trigger arbitrary filesystem " +
        "operations — it must not be invoked from production code.",
    );
  }
  // Set override BEFORE clearing so clearSlackThreadParticipationCache
  // doesn't delete the file at the new path we're about to hydrate from.
  // Stored on persistState (the global singleton) so that re-imports of
  // this module observe the override consistently.
  persistState.persistPathOverride = persistPath;
  threadParticipation.clear();
  persistState.entries.clear();
  if (persistState.persistTimer) {
    clearTimeout(persistState.persistTimer);
    persistState.persistTimer = null;
  }
  persistState.hydrated = false;
}
