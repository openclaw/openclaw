/**
 * Active-tag-set auto-collapse rule (Phase 2, 02-03; spec §6.3). Decides which live
 * boxes have fallen out of the current topic and should collapse. Pure core: data in
 * (turns + spans + boxes), collapse decisions out — `applyAutoCollapse` is the thin
 * I/O wrapper that reads the per-agent store and flips `boxes.state`.
 *
 * Rule: the active-tag set is the union of span topics over the last
 * `activeWindowTurns` non-noise turns. A box stays live while it overlaps the active
 * set; below the overlap threshold it is collapse-eligible, but only collapses once the
 * active set is meaningfully large (`activeSetCardinalityFloor`) and the box's most
 * recent owned turn is at least the dwell behind the head (anti-thrash). The rule only
 * ever collapses; expansion is always manual or retrieval-driven.
 *
 * The thresholds AND the overlap-test SHAPE are injected via `CollapseParams` so the
 * Phase-4 tuning harness can sweep the two escalated-open candidates over identical
 * input without mutating module state (§16): grok-1 ("jaccard-distance") keeps a box
 * live while Jaccard overlap ≥ the cutoff; gemini-1 ("zero-intersection") keeps it live
 * while ANY topic overlaps and only collapses on an empty intersection past a longer
 * dwell. `DEFAULT_PARAMS` reproduces today's shipped jaccard-distance decisions from
 * accordion-constants.ts; production behavior is unchanged.
 */
import {
  ACTIVE_SET_CARDINALITY_FLOOR,
  ACTIVE_WINDOW_TURNS,
  COLLAPSE_DWELL_TURNS,
  JACCARD_LIVE_CUTOFF,
} from "./accordion-constants.js";
import { isSuppressedMemoryNoise } from "./noise.js";
import { listBoxes, listSpans, getTurns, setBoxState } from "./turns-store.js";
import type { BoxState } from "./turns-store.js";

/**
 * Injected tuning contract for {@link decideAutoCollapse}. The `mode` discriminator
 * selects the overlap-test SHAPE (not just numbers) so competing Phase-4 candidates are
 * sweepable without module-state mutation. Both variants share the active window and the
 * cardinality floor; each carries only the fields its own eligibility test reads.
 */
export type CollapseParams =
  | {
      // grok-1: box stays live while Jaccard overlap ≥ jaccardLiveCutoff.
      mode: "jaccard-distance";
      activeWindowTurns: number;
      jaccardLiveCutoff: number;
      collapseDwellTurns: number;
      activeSetCardinalityFloor: number;
    }
  | {
      // gemini-1: box stays live while ANY topic overlaps; collapses only on an empty
      // intersection past zeroIntersectionDwellTurns.
      mode: "zero-intersection";
      activeWindowTurns: number;
      zeroIntersectionDwellTurns: number;
      activeSetCardinalityFloor: number;
    };

/**
 * Shipped defaults: the jaccard-distance shape built from accordion-constants.ts, so the
 * single production caller reproduces pre-parameterization decisions byte-for-byte. The
 * four tuning constants are read ONLY here — never inside the rule body — so a sweep that
 * passes other params can never pick up a stale module constant.
 */
export const DEFAULT_PARAMS: CollapseParams = {
  mode: "jaccard-distance",
  activeWindowTurns: ACTIVE_WINDOW_TURNS,
  jaccardLiveCutoff: JACCARD_LIVE_CUTOFF,
  collapseDwellTurns: COLLAPSE_DWELL_TURNS,
  activeSetCardinalityFloor: ACTIVE_SET_CARDINALITY_FLOOR,
};

/** Minimal turn shape the rule needs — a superset is fine (TurnRow satisfies it). */
export type TurnLike = {
  seq: number;
  content: string;
  channel?: string | null;
  noise_class?: string | null;
};

/** Minimal span shape — TurnRow's sibling SpanRow satisfies it. */
export type SpanLike = {
  start_seq: number;
  end_seq: number;
  topic?: string | null;
  box_id?: string | null;
  noise_class?: string | null;
};

/** Minimal box shape. */
export type BoxLike = {
  box_id: string;
  state: string;
  last_active_seq?: number | null;
};

export type CollapseInput = {
  turns: readonly TurnLike[];
  spans: readonly SpanLike[];
  boxes: readonly BoxLike[];
};

/** Find the span that owns a given turn seq (spans are non-overlapping ranges). */
function spanForSeq(spans: readonly SpanLike[], seq: number): SpanLike | undefined {
  return spans.find((s) => s.start_seq <= seq && seq <= s.end_seq);
}

function isNoiseTurn(turn: TurnLike, span: SpanLike | undefined): boolean {
  return isSuppressedMemoryNoise(turn) || span?.noise_class === "suppressed";
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a box's owned topics keep it live under the params' overlap shape. grok-1
 * uses a Jaccard cutoff; gemini-1 keeps it live while any topic still overlaps.
 */
function staysLive(
  params: CollapseParams,
  boxTopics: ReadonlySet<string>,
  activeTopics: ReadonlySet<string>,
): boolean {
  if (params.mode === "jaccard-distance") {
    return jaccard(boxTopics, activeTopics) >= params.jaccardLiveCutoff;
  }
  return intersects(boxTopics, activeTopics);
}

/** The non-noise-turn dwell a collapse-eligible box must sit behind the head. */
function dwellFloor(params: CollapseParams): number {
  return params.mode === "jaccard-distance"
    ? params.collapseDwellTurns
    : params.zeroIntersectionDwellTurns;
}

/**
 * Decide which currently-live boxes should collapse. Pure; returns box ids in input
 * order. The overlap-test shape and all thresholds come from `params` (default
 * DEFAULT_PARAMS = shipped jaccard-distance behavior). Recency enters via the dwell: a
 * box whose owned topics last appeared within the dwell of the head is protected (so is
 * a freshly manual-expanded box, whose `last_active_seq` was bumped to the head).
 */
export function decideAutoCollapse(
  input: CollapseInput,
  params: CollapseParams = DEFAULT_PARAMS,
): string[] {
  // Non-noise turns in seq order; the active window is the most recent N of these.
  const nonNoise = input.turns
    .filter((turn) => !isNoiseTurn(turn, spanForSeq(input.spans, turn.seq)))
    .toSorted((a, b) => a.seq - b.seq);
  if (nonNoise.length === 0) {
    return [];
  }
  const window = nonNoise.slice(-params.activeWindowTurns);

  const activeTopics = new Set<string>();
  for (const turn of window) {
    const topic = spanForSeq(input.spans, turn.seq)?.topic;
    if (topic) {
      activeTopics.add(topic);
    }
  }

  // Topics owned by each box, plus the latest non-noise seq touching each topic.
  const boxTopics = new Map<string, Set<string>>();
  for (const span of input.spans) {
    if (span.box_id && span.topic) {
      const set = boxTopics.get(span.box_id) ?? new Set<string>();
      set.add(span.topic);
      boxTopics.set(span.box_id, set);
    }
  }
  const latestSeqByTopic = new Map<string, number>();
  for (const turn of nonNoise) {
    const topic = spanForSeq(input.spans, turn.seq)?.topic;
    if (topic) {
      latestSeqByTopic.set(topic, turn.seq);
    }
  }
  const headSeq = nonNoise[nonNoise.length - 1].seq;

  const toCollapse: string[] = [];
  for (const box of input.boxes) {
    if (box.state !== "live") {
      continue;
    }
    const topics = boxTopics.get(box.box_id);
    if (!topics || topics.size === 0) {
      continue;
    }
    if (staysLive(params, topics, activeTopics)) {
      continue;
    }
    // Eligible: require a meaningful active set so one short burst can't collapse all.
    if (activeTopics.size < params.activeSetCardinalityFloor) {
      continue;
    }
    // Anti-thrash: most recent owned turn (or a manual-expand head bump) must be at
    // least the dwell's worth of non-noise turns behind the head.
    let lastTouch = box.last_active_seq ?? 0;
    for (const topic of topics) {
      lastTouch = Math.max(lastTouch, latestSeqByTopic.get(topic) ?? 0);
    }
    const dwell = nonNoise.filter((turn) => turn.seq > lastTouch).length;
    if (dwell < dwellFloor(params)) {
      continue;
    }
    if (headSeq <= lastTouch) {
      continue;
    }
    toCollapse.push(box.box_id);
  }
  return toCollapse;
}

/**
 * Read the per-agent store, run the rule, and collapse any stale boxes. Returns the
 * collapsed box ids. Manual overrides need no special-casing: a manual expand bumps
 * `last_active_seq`, so the same dwell keeps the box live until the topic moves on.
 */
export function applyAutoCollapse(options: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const scope = { agentId: options.agentId, sessionKey: options.sessionKey } as const;
  const dbOpts = options.env ? { ...scope, env: options.env } : scope;
  const boxes = listBoxes(dbOpts);
  if (!boxes.some((box) => box.state === "live")) {
    return [];
  }
  const decisions = decideAutoCollapse(
    {
      turns: getTurns(dbOpts),
      spans: listSpans(dbOpts),
      boxes,
    },
    DEFAULT_PARAMS,
  );
  const collapsed: BoxState = "collapsed";
  for (const boxId of decisions) {
    setBoxState({ ...dbOpts, boxId, state: collapsed });
  }
  return decisions;
}
