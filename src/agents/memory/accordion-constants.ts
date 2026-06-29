/**
 * Accordion auto-collapse tuning constants (Phase 2, 02-03). Single source of truth
 * for the active-tag-set rule (spec §6.3). Every value here is an escalated-open
 * default (spec §16 "Open"): the *mechanism* ships in Phase 2 so the accordion is
 * testable, but the *constants* are deliberately not locked — Phase 4 evaluates the
 * competing candidates (grok-1's Jaccard-distance ≥ 0.5 + |active_set| ≥ 3 guard;
 * gemini-1's zero-intersection ≥ 5-turn dwell) against held-out spike data before
 * locking values. Do not scatter these numbers elsewhere; import from here.
 */

/**
 * TUNABLE (Phase 4 — §16). Size of the recency window: the active-tag set is the
 * union of broad tags over the last N captured non-noise turns.
 */
export const ACTIVE_WINDOW_TURNS = 12;

/**
 * TUNABLE (Phase 4 — §16). A box stays live while its tag set's Jaccard overlap with
 * the active-tag set is at least this cutoff; below it the box is collapse-eligible.
 */
export const JACCARD_LIVE_CUTOFF = 0.3;

/**
 * TUNABLE (Phase 4 — §16). Anti-thrash dwell: a collapse-eligible box only actually
 * collapses after its most recent owned turn is at least this many non-noise turns
 * behind the conversation head. A manual expand bumps the box's last-active head, so
 * the same dwell protects an operator override until the topic genuinely moves on.
 */
export const COLLAPSE_DWELL_TURNS = 6;

/**
 * TUNABLE (Phase 4 — §16). Cardinality floor: collapse decisions are suppressed until
 * the active-tag set holds at least this many distinct tags, so a single short topic
 * burst cannot collapse everything around it.
 */
export const ACTIVE_SET_CARDINALITY_FLOOR = 2;

/**
 * TUNABLE (Phase 4 — §16). Cheap online segmentation keeps a span open while
 * lexical topic overlap stays at or above this cutoff.
 */
export const SEGMENT_TOPIC_SIMILARITY_CUTOFF = 0.25;

/**
 * TUNABLE (Phase 4 — §16). Number of salient tokens used in the provisional
 * normalized topic label before the tag-DAG slice maps labels to durable tags.
 */
export const SEGMENT_TOPIC_TOKEN_LIMIT = 1;
