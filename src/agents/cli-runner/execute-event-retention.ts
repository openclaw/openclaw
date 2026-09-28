// Bounds on the per-run state the CLI event consumers retain.
//
// `cli-output-tool-tracker.ts` bounds what the *parser* holds. These bound what
// the parser's consumers hold: `createCliEventHandlers` keeps a summary entry
// per distinct tool call plus the start arguments of every call whose result has
// not arrived, and `createCliToolTracking` keeps one active-tool entry per
// unfinished non-server tool call. All of that used to be bounded only by how
// long a turn could stream, because a spent turn budget stopped the parser from
// delivering any further records at all. It no longer does — a spent budget now
// keeps projecting tool starts and results so the gateway's stall detector still
// sees progress — so these are the direct bound on the consumer side of that
// path.
//
// Two eviction policies, chosen per structure and not interchangeable:
//
//  - FIFO eviction, matching `cli-output-tool-tracker.ts`. Its worst case is a
//    summary or argument entry for a call that last appeared thousands of calls
//    earlier. Used where the oldest entry is the least useful one.
//  - Refuse-new past the cap, never evicting. Used for the maps that describe
//    which tools are still RUNNING, where the oldest entry is the long-lived
//    foreground `Agent` call whose attributed progress keeps the recovery clock
//    alive. Evicting there would re-create the abort this branch exists to
//    prevent, so a pathological stream loses tracking for the newest tool
//    instead of for the one that matters.

/** Distinct tool calls whose `{ name, failed }` summary entry is retained. */
export const MAX_TRACKED_TOOL_SUMMARIES = 4096;
/** Distinct tool names retained for the run's tool-summary trace. */
export const MAX_TRACKED_TOOL_NAMES = 256;
/** Tool calls that may be tracked as started-but-not-finished at one time. */
export const MAX_UNFINISHED_TOOL_CALLS = 1024;
// Matches `MAX_PENDING_TOOL_INPUT_CHARS` in `cli-output-tool-tracker.ts` and the
// per-turn raw-character budget: retained tool arguments may not outgrow the
// traffic a whole turn is allowed to be charged for. A count cap alone bounds
// nothing here, because one tool call's decoded arguments can approach that same
// 8 MiB on their own.
export const MAX_RETAINED_TOOL_ARG_CHARS = 8 * 1024 * 1024;

/** Insertion-ordered structures shrink from the front; `Map` and `Set` both qualify. */
type OldestFirstKeys = {
  readonly size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
};

/**
 * Drops oldest-first until `entries` is within `max`. `onEvict` runs before the
 * delete, so a caller can refund whatever accounting the entry charged.
 */
export function evictOldestEntries(
  entries: OldestFirstKeys,
  max: number,
  onEvict?: (key: string) => void,
): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      return;
    }
    onEvict?.(oldest.value);
    entries.delete(oldest.value);
  }
}

/**
 * The retained size of a decoded tool-argument object, measured the way
 * `cli-output-tool-tracker.ts` measures a start snapshot: the length of the
 * serialized form, which is the length of the stream text it was decoded from.
 */
export function measureToolArgChars(args: Record<string, unknown>): number {
  try {
    return JSON.stringify(args)?.length ?? 0;
  } catch {
    // Arguments that cannot be serialized cannot have been decoded from the
    // JSONL stream, so the safe reading is "unknown size, therefore not
    // retainable".
    return MAX_RETAINED_TOOL_ARG_CHARS + 1;
  }
}
