/**
 * Resumable backfill checkpoints (Phase 4, 04-02). Both backfill stages (seed +
 * organize) record their progress in the per-agent SQLite `cache_entries` KV under the
 * `memory-backfill` scope — NO sidecar/JSONL file, no schema bump (root AGENTS storage
 * rule: SQLite-first runtime state). The cursor is what makes an interrupted run
 * resumable: seed skips already-finished transcript files; organize skips the
 * already-run segmentation step.
 */
import {
  readSqliteAgentCacheEntry,
  writeSqliteAgentCacheEntry,
} from "../cache/agent-cache-store.sqlite.js";

/**
 * Spread-friendly optional `env`. Under exactOptionalPropertyTypes we must never pass
 * `env: undefined`, so every per-agent DB call sites omits the key when env is absent;
 * this is the single shared spelling of that spread.
 */
export function withEnv(env?: NodeJS.ProcessEnv): { env?: NodeJS.ProcessEnv } {
  return env ? { env } : {};
}

/** KV scope shared by both stages; keeps backfill checkpoints isolated from other caches. */
const BACKFILL_SCOPE = "memory-backfill";

/**
 * Seed progress: the transcript file basenames already replayed into `turns`, the last
 * idempotency key appended, and the highest message-order key seeded so far. `completedFiles`
 * lets a resumed run skip finished files; re-appending is harmless anyway (idempotency_key
 * dedup), so it is purely an optimization. `lastSeededTs` lets a later run detect when it is
 * about to append content OLDER than what was already seeded (out-of-order seq assignment).
 */
export type SeedCursor = {
  completedFiles: string[];
  lastIdempotencyKey: string | null;
  lastSeededTs: number | null;
};

/**
 * Organize progress per session: `segmented` once core segmentation + association has run
 * (this is what satisfies SC1 "searchable"). The optional memory-core dreaming sweep /
 * retrieval indexing (RETR-01) is not wired here, so the cursor carries no flag for it; the
 * dreaming tier will own its own checkpoint when it lands.
 */
export type OrganizeCursor = {
  segmented: boolean;
};

type CursorOptions = {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
};

function scopeOptions(options: CursorOptions): {
  agentId: string;
  scope: string;
  env?: NodeJS.ProcessEnv;
} {
  return {
    agentId: options.agentId,
    scope: BACKFILL_SCOPE,
    ...withEnv(options.env),
  };
}

function seedKey(sessionKey: string): string {
  return `seed:${sessionKey}`;
}

function organizeKey(sessionKey: string): string {
  return `organize:${sessionKey}`;
}

export function readSeedCursor(options: CursorOptions): SeedCursor | undefined {
  const row = readSqliteAgentCacheEntry({
    ...scopeOptions(options),
    key: seedKey(options.sessionKey),
  });
  return row?.value == null ? undefined : (row.value as SeedCursor);
}

export function writeSeedCursor(options: CursorOptions & { value: SeedCursor }): void {
  writeSqliteAgentCacheEntry({
    ...scopeOptions(options),
    key: seedKey(options.sessionKey),
    value: options.value,
  });
}

export function readOrganizeCursor(options: CursorOptions): OrganizeCursor | undefined {
  const row = readSqliteAgentCacheEntry({
    ...scopeOptions(options),
    key: organizeKey(options.sessionKey),
  });
  return row?.value == null ? undefined : (row.value as OrganizeCursor);
}

export function writeOrganizeCursor(options: CursorOptions & { value: OrganizeCursor }): void {
  writeSqliteAgentCacheEntry({
    ...scopeOptions(options),
    key: organizeKey(options.sessionKey),
    value: options.value,
  });
}
