/**
 * Offline tuning harness (Phase 4, 04-04 — D-08). Replays the parameterized `decideAutoCollapse`
 * (04-01) over the agent's BACKFILLED `agent:{id}:main` history under each candidate rule-set
 * (current baseline + grok-1 + gemini-1), builds each candidate's collapse timeline by stepping
 * through the non-noise seqs, scores every timeline against the deterministic resurfacing
 * reference (recall-safety-first, D-09), and ranks by the objective `value`. It surfaces the
 * winner, per-candidate aggregate metrics, the decisive disagreements between the top two, and a
 * before/after evidence block of AGGREGATE NUMBERS ONLY — never raw transcript content, because
 * the underlying history holds client/legal PII (T-04D-01).
 *
 * The harness does NOT write the tuning constants file; the operator-confirm gate + the lock
 * step own that (D-08). It only reads the store and returns numbers.
 */
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  decideAutoCollapse,
  DEFAULT_PARAMS,
  type BoxLike,
  type CollapseInput,
  type CollapseParams,
} from "./active-tag-set.js";
import { listMemoryAssociations } from "./associative-store.js";
import { withEnv } from "./backfill-cursor.js";
import { scoreCandidate, type CandidateScore, type CollapseEvent } from "./tuning-objective.js";
import { buildResurfacingReference } from "./tuning-resurfacing.js";
import { getTurns, listBoxes, listSpans } from "./turns-store.js";

export type CandidateSpec = { name: string; params: CollapseParams };

export type RankedCandidate = {
  name: string;
  params: CollapseParams;
  score: CandidateScore;
};

export type TuningDisagreement = {
  boxId: string;
  winnerCollapseSeq: number | null;
  runnerUpCollapseSeq: number | null;
};

/** Aggregate-only evidence safe to paste into a PR body (no transcript content). */
export type TuningEvidence = {
  baseline: { name: string; recallFailures: number; savingsPct: number; value: number };
  winner: {
    name: string;
    recallFailures: number;
    savingsPct: number;
    value: number;
    params: CollapseParams;
  };
  candidates: {
    name: string;
    recallFailures: number;
    savingsPct: number;
    thrash: number;
    value: number;
  }[];
};

export type TuningHarnessResult = {
  ranked: RankedCandidate[];
  winner: RankedCandidate;
  evidence: TuningEvidence;
  disagreements: TuningDisagreement[];
};

/**
 * The two escalated-open candidates (spec §16 docstrings) alongside the shipped baseline. grok-1
 * keeps a box live until Jaccard overlap drops below 0.5 and needs |active_set| >= 3; gemini-1
 * keeps it live until the intersection is empty, then collapses past a 5-turn dwell.
 */
function defaultCandidates(): CandidateSpec[] {
  return [
    { name: "baseline", params: DEFAULT_PARAMS },
    {
      name: "grok-1",
      params: {
        mode: "jaccard-distance",
        activeWindowTurns: 12,
        jaccardLiveCutoff: 0.5,
        collapseDwellTurns: 6,
        activeSetCardinalityFloor: 3,
      },
    },
    {
      name: "gemini-1",
      params: {
        mode: "zero-intersection",
        activeWindowTurns: 12,
        zeroIntersectionDwellTurns: 5,
        activeSetCardinalityFloor: 2,
      },
    },
  ];
}

function savingsPct(savings: number): number {
  return Math.round(savings * 1000) / 10;
}

type StoreRows = {
  turns: CollapseInput["turns"];
  spans: CollapseInput["spans"];
  boxes: readonly BoxLike[];
};

/**
 * Replay the rule step-by-step over the non-noise seqs. The rule is evaluated once per distinct
 * non-noise seq (a faithful replay — we never reimplement decideAutoCollapse), but the per-step
 * overhead is kept flat: the growing prefix is extended with sorted-array pointers instead of
 * re-filtering the whole history every step, and a single box-state array is mutated in place
 * instead of rebuilt. State is carried forward — once a box collapses it stays collapsed (the
 * accordion never auto-re-expands), so each box's collapse seq is the FIRST step its id appears
 * in the rule's output. Returns the collapse seq per box.
 */
function replayCollapseSeqs(rows: StoreRows, params: CollapseParams): Map<string, number> {
  // getTurns/listSpans already order ascending; sort defensively so the pointer walk is correct
  // regardless of caller-supplied row order. Span order does not affect decideAutoCollapse output.
  const sortedTurns = [...rows.turns].toSorted((a, b) => a.seq - b.seq);
  const sortedSpans = [...rows.spans].toSorted((a, b) => a.start_seq - b.start_seq);
  const stepSeqs = [
    ...new Set(sortedTurns.filter((t) => t.noise_class !== "suppressed").map((t) => t.seq)),
  ].toSorted((a, b) => a - b);

  const prefixTurns: CollapseInput["turns"][number][] = [];
  const prefixSpans: CollapseInput["spans"][number][] = [];
  const boxInput: BoxLike[] = rows.boxes.map((box) => ({ ...box, state: "live" }));
  const boxIndexById = new Map(boxInput.map((box, index) => [box.box_id, index]));
  const collapseSeqByBox = new Map<string, number>();

  let turnIdx = 0;
  let spanIdx = 0;
  for (const step of stepSeqs) {
    while (turnIdx < sortedTurns.length && sortedTurns[turnIdx].seq <= step) {
      prefixTurns.push(sortedTurns[turnIdx]);
      turnIdx += 1;
    }
    // Only spans started by this step exist yet — bounds box topics to what was seen so far.
    while (spanIdx < sortedSpans.length && sortedSpans[spanIdx].start_seq <= step) {
      prefixSpans.push(sortedSpans[spanIdx]);
      spanIdx += 1;
    }
    const collapsed = decideAutoCollapse(
      { turns: prefixTurns, spans: prefixSpans, boxes: boxInput },
      params,
    );
    for (const boxId of collapsed) {
      if (collapseSeqByBox.has(boxId)) {
        continue;
      }
      collapseSeqByBox.set(boxId, step);
      const index = boxIndexById.get(boxId);
      if (index !== undefined) {
        boxInput[index] = { ...boxInput[index], state: "collapsed" };
      }
    }
    // Every box has collapsed and the rule never re-expands — no later step can change anything.
    if (collapseSeqByBox.size === boxInput.length) {
      break;
    }
  }
  return collapseSeqByBox;
}

/**
 * Resolve entity reappearances into per-box seq sets from memory_associations (cross-box aware):
 * each entity's occurrence seqs are folded into every box that owns it, directly into per-box
 * sets — no intermediate (boxId, seq) cartesian array (buildResurfacingReference consumes the map).
 */
function resolveEntityReappearances(
  spans: CollapseInput["spans"],
  associations: ReturnType<typeof listMemoryAssociations>,
): Map<string, Set<number>> {
  const spanById = new Map(
    spans.map((span) => [(span as { span_id?: string }).span_id ?? "", span]),
  );
  const seqsByEntity = new Map<string, Set<number>>();
  const boxesByEntity = new Map<string, Set<string>>();
  for (const assoc of associations) {
    if (!assoc.entity_id || assoc.target_type !== "span") {
      continue;
    }
    const span = spanById.get(assoc.target_id);
    if (!span || !span.box_id) {
      continue;
    }
    const seqs = seqsByEntity.get(assoc.entity_id) ?? new Set<number>();
    for (let seq = span.start_seq; seq <= span.end_seq; seq += 1) {
      seqs.add(seq);
    }
    seqsByEntity.set(assoc.entity_id, seqs);
    const boxes = boxesByEntity.get(assoc.entity_id) ?? new Set<string>();
    boxes.add(span.box_id);
    boxesByEntity.set(assoc.entity_id, boxes);
  }
  const seqsByBox = new Map<string, Set<number>>();
  for (const [entityId, boxes] of boxesByEntity) {
    const seqs = seqsByEntity.get(entityId);
    if (!seqs) {
      continue;
    }
    for (const boxId of boxes) {
      const target = seqsByBox.get(boxId) ?? new Set<number>();
      for (const seq of seqs) {
        target.add(seq);
      }
      seqsByBox.set(boxId, target);
    }
  }
  return seqsByBox;
}

function eventsFromMap(collapseSeqByBox: Map<string, number>): CollapseEvent[] {
  return [...collapseSeqByBox].map(([boxId, collapseSeq]) => ({ boxId, collapseSeq }));
}

function disagreementsBetween(
  winner: Map<string, number>,
  runnerUp: Map<string, number>,
): TuningDisagreement[] {
  const boxIds = new Set([...winner.keys(), ...runnerUp.keys()]);
  const out: TuningDisagreement[] = [];
  for (const boxId of boxIds) {
    const w = winner.get(boxId) ?? null;
    const r = runnerUp.get(boxId) ?? null;
    if (w !== r) {
      out.push({ boxId, winnerCollapseSeq: w, runnerUpCollapseSeq: r });
    }
  }
  return out.toSorted((a, b) => a.boxId.localeCompare(b.boxId));
}

export function runTuningHarness(options: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  candidates?: CandidateSpec[];
}): TuningHarnessResult {
  const agentId = normalizeAgentId(options.agentId);
  const sessionKey = `agent:${agentId}:main`;
  const dbOpts = { agentId, sessionKey, ...withEnv(options.env) };

  const turns = getTurns(dbOpts);
  const spans = listSpans(dbOpts);
  const boxes = listBoxes(dbOpts);
  const associations = listMemoryAssociations(dbOpts);

  const reference = buildResurfacingReference({
    turns,
    spans,
    boxes,
    entitySeqsByBox: resolveEntityReappearances(spans, associations),
  });

  const candidates = options.candidates ?? defaultCandidates();
  const rows: StoreRows = { turns, spans, boxes };
  const collapseMaps = new Map<string, Map<string, number>>();
  const ranked: RankedCandidate[] = candidates.map((candidate) => {
    const collapseSeqByBox = replayCollapseSeqs(rows, candidate.params);
    collapseMaps.set(candidate.name, collapseSeqByBox);
    const score = scoreCandidate({ events: eventsFromMap(collapseSeqByBox) }, reference);
    return { name: candidate.name, params: candidate.params, score };
  });
  // Recall-safety-first: higher value wins; ties broken by name for determinism.
  ranked.sort((a, b) => b.score.value - a.score.value || a.name.localeCompare(b.name));

  const winner = ranked[0];
  const runnerUp = ranked[1] ?? ranked[0];
  const baseline = ranked.find((candidate) => candidate.name === "baseline") ?? ranked[0];

  const evidence: TuningEvidence = {
    baseline: {
      name: baseline.name,
      recallFailures: baseline.score.recallFailures,
      savingsPct: savingsPct(baseline.score.savings),
      value: baseline.score.value,
    },
    winner: {
      name: winner.name,
      recallFailures: winner.score.recallFailures,
      savingsPct: savingsPct(winner.score.savings),
      value: winner.score.value,
      params: winner.params,
    },
    candidates: ranked.map((candidate) => ({
      name: candidate.name,
      recallFailures: candidate.score.recallFailures,
      savingsPct: savingsPct(candidate.score.savings),
      thrash: candidate.score.thrash,
      value: candidate.score.value,
    })),
  };

  return {
    ranked,
    winner,
    evidence,
    disagreements: disagreementsBetween(
      collapseMaps.get(winner.name) ?? new Map(),
      collapseMaps.get(runnerUp.name) ?? new Map(),
    ),
  };
}
