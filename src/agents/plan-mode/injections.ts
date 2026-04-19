/**
 * Pending agent injection queue (post-PR-15 nuclear rewrite).
 *
 * Replaces the single-scalar `SessionEntry.pendingAgentInjection: string`
 * field with an append-only, priority-ordered, id-dedup'd queue. Fixes
 * the last-write-wins clobber class of bug where a `[QUESTION_ANSWER]`
 * or `[PLAN_COMPLETE]` landing between `/plan accept` and runner consume
 * would silently overwrite the `[PLAN_DECISION]`.
 *
 * ## Semantics
 *
 * - **Append on write**: every writer goes through
 *   `enqueuePendingAgentInjection` which atomically appends to the
 *   queue. If an entry with the same `id` already exists, the entry is
 *   upserted (not duplicated). This lets writers regenerate a stable
 *   id from `approvalId` or session state to guarantee idempotency.
 * - **Priority-ordered drain**: `consumePendingAgentInjections` reads
 *   all non-expired entries, sorts by `priority DESC, createdAt ASC`,
 *   clears the queue, and returns the composed text.
 * - **Once-and-only-once**: clear and read happen inside one
 *   `updateSessionStoreEntry` call (single store lock). Best-effort on
 *   write failure — captured entries are still returned so the turn
 *   can inject; the queue will be cleared on the next successful
 *   write.
 * - **Legacy migration**: if an older session on disk has the legacy
 *   `pendingAgentInjection: string` field, the consumer auto-promotes
 *   it to a single-element queue (with `kind: "plan_decision"`, a safe
 *   default for the most-common legacy writer) and deletes the scalar.
 *   No separate migration script needed.
 * - **Bounded queue**: capped at `MAX_QUEUE_SIZE = 10`. Oldest entries
 *   evicted on overflow with a warn log. Correctness doesn't depend on
 *   this — the consumer always drains within a single turn — but the
 *   cap prevents unbounded growth in pathological cases (stuck session,
 *   consumer crash loop).
 */

import { loadConfig } from "../../config/io.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import type { PendingAgentInjectionEntry, SessionEntry } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";

export type {
  PendingAgentInjectionEntry,
  PendingAgentInjectionKind,
} from "../../config/sessions/types.js";

/**
 * Priority lookup for default ordering. Writers may override on the
 * entry. Higher drains first; ties broken by `createdAt` ascending.
 */
export const DEFAULT_INJECTION_PRIORITY: Record<string, number> = {
  plan_decision: 10,
  plan_complete: 9,
  question_answer: 8,
  subagent_return: 5,
  plan_intro: 3,
  plan_nudge: 1,
};

/**
 * Queue size cap. The consumer drains every turn so a well-behaved
 * session should never approach this. Eviction is oldest-first with a
 * warn log so operators can spot a stuck drain loop.
 */
export const MAX_QUEUE_SIZE = 10;

type Log = { warn?: (msg: string) => void; debug?: (msg: string) => void };

function resolveEntryPriority(entry: PendingAgentInjectionEntry): number {
  if (typeof entry.priority === "number") {
    return entry.priority;
  }
  return DEFAULT_INJECTION_PRIORITY[entry.kind] ?? 0;
}

function filterExpired(
  entries: PendingAgentInjectionEntry[],
  now: number,
): PendingAgentInjectionEntry[] {
  return entries.filter((e) => typeof e.expiresAt !== "number" || e.expiresAt > now);
}

/**
 * Promotes a legacy `pendingAgentInjection: string` into a single queue
 * entry. Idempotent: if the legacy field is absent, returns the input
 * queue unchanged.
 *
 * Classifies the legacy text as `plan_decision` (the dominant writer
 * pre-migration). This is a best-effort label; subsequent writes flow
 * through the properly-kinded enqueue helper.
 */
export function migrateLegacyPendingInjection(
  entry: SessionEntry,
  now: number,
): {
  queue: PendingAgentInjectionEntry[];
  migrated: boolean;
} {
  const queue = [...(entry.pendingAgentInjections ?? [])];
  const legacy = entry.pendingAgentInjection;
  if (typeof legacy !== "string" || legacy.length === 0) {
    return { queue, migrated: false };
  }
  queue.push({
    id: `legacy-${now}`,
    kind: "plan_decision",
    text: legacy,
    createdAt: now,
  });
  return { queue, migrated: true };
}

/**
 * Sorts a queue for drain order and applies the size cap.
 * Pure (no store I/O) so callers can test independently.
 */
export function sortAndCapQueue(
  queue: PendingAgentInjectionEntry[],
  log?: Log,
): PendingAgentInjectionEntry[] {
  const sorted = queue.toSorted((a, b) => {
    const pa = resolveEntryPriority(a);
    const pb = resolveEntryPriority(b);
    if (pa !== pb) {
      return pb - pa;
    }
    return a.createdAt - b.createdAt;
  });
  if (sorted.length <= MAX_QUEUE_SIZE) {
    return sorted;
  }
  const dropped = sorted.slice(MAX_QUEUE_SIZE);
  for (const d of dropped) {
    log?.warn?.(
      `pending-injection-queue: at cap ${MAX_QUEUE_SIZE}, dropping oldest entry id=${d.id} kind=${d.kind}`,
    );
  }
  return sorted.slice(0, MAX_QUEUE_SIZE);
}

/**
 * Appends or upserts an entry in the queue. If an entry with the same
 * `id` exists, it is replaced (regardless of position — stable dedup
 * across writer retries).
 *
 * Does NOT sort — ordering is applied at drain time so writers can
 * enqueue cheaply without re-sorting on every call.
 */
export function upsertIntoQueue(
  queue: PendingAgentInjectionEntry[],
  entry: PendingAgentInjectionEntry,
): PendingAgentInjectionEntry[] {
  const existingIdx = queue.findIndex((e) => e.id === entry.id);
  if (existingIdx >= 0) {
    const next = [...queue];
    next[existingIdx] = entry;
    return next;
  }
  return [...queue, entry];
}

/**
 * In-place mutator: appends an entry to a session's injection queue,
 * migrating any legacy scalar in the same pass. SYNCHRONOUS — for use
 * inside an existing `updateSessionStoreEntry` callback where the store
 * lock is already held. Do NOT call `enqueuePendingAgentInjection` from
 * such a context; it would deadlock on the re-entrant lock.
 *
 * Mutates `entry` in place. Returns nothing; the caller is expected to
 * return the mutated `entry` (or a Partial that includes the updated
 * queue) from their update callback.
 */
export function appendToInjectionQueue(
  entry: SessionEntry,
  newEntry: PendingAgentInjectionEntry,
  log?: Log,
): void {
  const now = Date.now();
  const migrated = migrateLegacyPendingInjection(entry, now);
  const next = upsertIntoQueue(migrated.queue, newEntry);
  const capped = sortAndCapQueue(next, log);
  entry.pendingAgentInjections = capped;
  if (migrated.migrated) {
    delete entry.pendingAgentInjection;
  }
}

/**
 * Atomically enqueues a pending injection for a session. Any existing
 * legacy scalar `pendingAgentInjection` on the entry is migrated into
 * the queue as part of the same write. Same-id entries are upserted.
 *
 * Returns `true` if the write succeeded, `false` if the session wasn't
 * found or the write failed (logged to `log.warn`). The contract is
 * best-effort — a persistent write failure does not throw because the
 * caller is typically a `sessions.patch` handler that should not
 * cascade a 500 on a subsystem that is not on the critical path.
 */
export async function enqueuePendingAgentInjection(
  sessionKey: string,
  entry: PendingAgentInjectionEntry,
  log?: Log,
): Promise<boolean> {
  if (!sessionKey || sessionKey.trim().length === 0) {
    return false;
  }
  try {
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    const result = await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (existing) => {
        const now = Date.now();
        const migrated = migrateLegacyPendingInjection(existing, now);
        const next = upsertIntoQueue(migrated.queue, entry);
        const capped = sortAndCapQueue(next, log);
        const patch: Partial<SessionEntry> = {
          pendingAgentInjections: capped,
        };
        // Explicit delete signals to the merge helper that we want the
        // legacy scalar removed.
        if (migrated.migrated) {
          (patch as Record<string, unknown>).pendingAgentInjection = undefined;
        }
        return patch;
      },
    });
    return result !== null;
  } catch (err) {
    log?.warn?.(
      `enqueuePendingAgentInjection failed id=${entry.id} kind=${entry.kind}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export interface ConsumePendingAgentInjectionsResult {
  /**
   * Drained entries in delivery order (priority DESC, createdAt ASC).
   * Empty array if nothing was pending.
   */
  injections: PendingAgentInjectionEntry[];
  /**
   * Entries joined with `\n\n` into a single synthetic user-message
   * preamble. `undefined` when the queue was empty (vs. empty string,
   * which would still cause the composer to emit a leading blank).
   */
  composedText: string | undefined;
}

/**
 * Atomically drains the queue for a session: reads all entries,
 * migrates any legacy scalar, filters expired, sorts, clears the
 * persisted queue, and returns the ordered entries plus a composed
 * text. Best-effort: on store-write failure the captured entries are
 * still returned so the caller can inject them into the next turn.
 */
export async function consumePendingAgentInjections(
  sessionKey: string,
  log?: Log,
): Promise<ConsumePendingAgentInjectionsResult> {
  if (!sessionKey || sessionKey.trim().length === 0) {
    return { injections: [], composedText: undefined };
  }
  let captured: PendingAgentInjectionEntry[] = [];
  try {
    const cfg = loadConfig();
    const parsed = parseAgentSessionKey(sessionKey);
    const storePath = resolveStorePath(
      cfg.session?.store,
      parsed?.agentId ? { agentId: parsed.agentId } : {},
    );
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (existing) => {
        const now = Date.now();
        const migrated = migrateLegacyPendingInjection(existing, now);
        const fresh = filterExpired(migrated.queue, now);
        captured = sortAndCapQueue(fresh, log);
        const patch: Partial<SessionEntry> = {
          pendingAgentInjections: undefined,
        };
        if (migrated.migrated) {
          (patch as Record<string, unknown>).pendingAgentInjection = undefined;
        }
        return patch;
      },
    });
  } catch (err) {
    log?.warn?.(
      `consumePendingAgentInjections failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // captured may still hold entries if the update callback ran before
    // the persist step threw. Deliver what we have rather than dropping.
  }
  const composedText = captured.length === 0 ? undefined : captured.map((e) => e.text).join("\n\n");
  return { injections: captured, composedText };
}

/**
 * Composes the agent's next-turn prompt by prepending a list of drained
 * injections to the user's input. Entries are joined with `\n\n`; the
 * combined block is separated from the user prompt by another `\n\n`.
 * If the user prompt is empty or whitespace-only, the injection stands
 * alone (no trailing blanks).
 */
export function composePromptWithPendingInjections(
  injections: readonly PendingAgentInjectionEntry[],
  userPrompt: string,
): string {
  if (injections.length === 0) {
    return userPrompt;
  }
  const preamble = injections.map((e) => e.text).join("\n\n");
  const trimmedUser = userPrompt.trim();
  if (trimmedUser.length === 0) {
    return preamble;
  }
  return `${preamble}\n\n${trimmedUser}`;
}
