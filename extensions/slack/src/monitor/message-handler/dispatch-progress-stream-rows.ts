import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import type { AgentPlanStep, ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import {
  buildSlackProgressStreamChunks,
  EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
  reconcileSlackNativeTaskChunks,
  resolveSlackNativeLineTaskId,
  resolveSlackReasoningTaskIndex,
  type SlackNativeStreamSnapshot,
} from "../../progress-blocks.js";
import { SLACK_REASONING_CONTINUED_TITLE } from "../../progress-reasoning.js";
import { planSlackStreamUpdateFit, SlackStreamMessageLedger } from "../../stream-size.js";

// Task rows the continuation must show again: authored plan steps are the
// turn's checklist, receipt and attention rows follow the turn's state.
function isSlackTurnScopedTaskId(id: string): boolean {
  return isSlackPlanStepTaskId(id) || id.startsWith("openclaw");
}

export function isSlackPlanStepTaskId(id: string): boolean {
  return id.startsWith("plan_step_");
}

function isTaskUpdate(chunk: AnyChunk): chunk is TaskUpdateChunk {
  return chunk.type === "task_update";
}

/**
 * Order in which plan rows take the slots a message has left for them:
 * running steps, then steps not started, then completed ones (already
 * visible on an earlier message), and within each group steps no message
 * has shown yet before steps shown before, in step order.
 */
function prioritizeSlackPlanRows(
  rows: readonly TaskUpdateChunk[],
  shownPlanStepIds: ReadonlySet<string>,
): TaskUpdateChunk[] {
  const rank = (row: TaskUpdateChunk) =>
    row.status === "in_progress" ? 0 : row.status === "complete" ? 2 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted(
      (left, right) =>
        rank(left.row) - rank(right.row) ||
        Number(shownPlanStepIds.has(left.row.id)) - Number(shownPlanStepIds.has(right.row.id)) ||
        left.index - right.index,
    )
    .map((entry) => entry.row);
}

/**
 * Fits the opening of a continuation under a fresh message's budget with
 * capacity for pending work first: the text (or room for it), the rows
 * that must carry, the pending cards the runtime will release next, and
 * only then plan rows in priority order. Plan rows that do not fit wait
 * for a later continuation; they are never deferred work.
 */
function budgetSlackContinuationOpening(open: {
  chunks: readonly AnyChunk[];
  /** Rows to hold room for that are not sent with the opening (queued cards). */
  reserveFor: readonly AnyChunk[];
  text?: string;
  shownPlanStepIds: ReadonlySet<string>;
}): {
  /** The opening in display order: title, plan rows, then the other rows. */
  chunks: AnyChunk[];
  planStepIds: Set<string>;
  /** A row that must carry did not fit. */
  deferred: boolean;
} {
  const planRows: TaskUpdateChunk[] = [];
  const otherRows: TaskUpdateChunk[] = [];
  const rest: AnyChunk[] = [];
  for (const chunk of open.chunks) {
    if (!isTaskUpdate(chunk)) {
      rest.push(chunk);
    } else if (isSlackPlanStepTaskId(chunk.id)) {
      planRows.push(chunk);
    } else {
      otherRows.push(chunk);
    }
  }
  const present = new Set(open.chunks.flatMap((chunk) => (isTaskUpdate(chunk) ? [chunk.id] : [])));
  const reserved = open.reserveFor.filter(
    (chunk): chunk is TaskUpdateChunk => isTaskUpdate(chunk) && !present.has(chunk.id),
  );
  const fresh = new SlackStreamMessageLedger();
  fresh.recordText(open.text);
  // Pending work first, then plan rows behind only the pending rows that
  // fit: the planner defers everything after the first row that does not,
  // so reserving more cards than one message takes would leave no plan row.
  const workFit = planSlackStreamUpdateFit(fresh, {
    chunks: [...rest, ...otherRows, ...reserved],
  });
  const fit = planSlackStreamUpdateFit(fresh, {
    chunks: [
      ...rest,
      ...otherRows.filter((row) => workFit.admittedTaskIds.has(row.id)),
      ...reserved.filter((row) => workFit.admittedTaskIds.has(row.id)),
      ...prioritizeSlackPlanRows(planRows, open.shownPlanStepIds),
    ],
  });
  const admittedPlan = planRows.filter((row) => fit.admittedTaskIds.has(row.id));
  return {
    chunks: [
      ...rest,
      ...admittedPlan,
      ...otherRows.filter((row) => workFit.admittedTaskIds.has(row.id)),
    ],
    planStepIds: new Set(admittedPlan.map((row) => row.id)),
    deferred: otherRows.some((row) => workFit.deferredTaskIds.has(row.id)),
  };
}

/** Rendered state of a task row: what a later result would change. */
function resolveSlackFrozenRowState(chunk: AnyChunk): string | undefined {
  return chunk.type === "task_update"
    ? JSON.stringify([chunk.title, chunk.status, chunk.details ?? "", chunk.output ?? ""])
    : undefined;
}

/** Frozen rows whose rendered state moved on: they carry a result and may render again. */
export function resolveThawedSlackRows(params: {
  lines: readonly ChannelProgressDraftLine[];
  frozenRows: ReadonlyMap<string, string>;
  maxLineChars: number;
  summaryRow: boolean;
}): string[] {
  const frozenLines = params.lines.filter((line) => {
    const id = resolveSlackNativeLineTaskId(line);
    return id !== undefined && params.frozenRows.has(id);
  });
  if (frozenLines.length === 0) {
    return [];
  }
  const thawed: string[] = [];
  for (const chunk of buildSlackProgressStreamChunks({
    lines: frozenLines,
    maxLineChars: params.maxLineChars,
    summaryRow: params.summaryRow,
  }) ?? []) {
    if (chunk.type !== "task_update") {
      continue;
    }
    const frozen = params.frozenRows.get(chunk.id);
    if (frozen !== undefined && frozen !== resolveSlackFrozenRowState(chunk)) {
      thawed.push(chunk.id);
    }
  }
  return thawed;
}

/**
 * Plan rows a continuation left out that fit beside what it holds and the
 * text to come, in priority order, so the turn ends showing the plan's true
 * state as far as one message allows.
 */
export function resolveSlackCompletionPlanRows(params: {
  plan: readonly AgentPlanStep[] | undefined;
  planStepIds: ReadonlySet<string>;
  shownPlanStepIds: ReadonlySet<string>;
  ledger: SlackStreamMessageLedger;
  reserveText?: string;
  maxLineChars: number;
  summaryRow: boolean;
}): string[] {
  const candidates: TaskUpdateChunk[] = [];
  for (const chunk of buildSlackProgressStreamChunks({
    lines: [],
    plan: params.plan,
    maxLineChars: params.maxLineChars,
    summaryRow: params.summaryRow,
  }) ?? []) {
    if (isTaskUpdate(chunk) && !params.planStepIds.has(chunk.id)) {
      candidates.push(chunk);
    }
  }
  if (candidates.length === 0) {
    return [];
  }
  const fit = planSlackStreamUpdateFit(params.ledger, {
    ...(params.reserveText ? { text: params.reserveText } : {}),
    chunks: prioritizeSlackPlanRows(candidates, params.shownPlanStepIds),
  });
  return [...fit.admittedTaskIds];
}

/**
 * What a finished message keeps. Rows Slack acknowledged are retired, and
 * the reasoning cards through the newest one among them are sealed. Rows
 * still running when the message closed stay with the chain (closing a
 * message does not finish its tools; the newest reasoning card is not one
 * of them, its cut is final) unless the message overflowed with rows it
 * could not take: then they are frozen with their rendered state, retired
 * like delivered rows so continuations do not fill up with them again, and
 * thaw when a result changes that state. When the closeout was rejected,
 * every row it would have changed (a card extended since it was sent, a
 * tool row with new details, output or a terminal status) also stays, as
 * the reconciler decides field by field against what Slack holds.
 */
export function planSlackMessageRetirement(retire: {
  previous: SlackNativeStreamSnapshot;
  full: AnyChunk[] | undefined;
  /** Rows on the message after the closeout, when Slack accepted it. */
  finished: SlackNativeStreamSnapshot;
  chunksRejected: boolean;
}): {
  retiredTaskIds: string[];
  frozenRows: Map<string, string>;
  /** Highest reasoning card among the retired rows. */
  rolledThroughCard: number;
} {
  const onMessage = retire.chunksRejected ? retire.previous : retire.finished;
  const overflowing = (retire.full ?? []).some(
    (chunk) =>
      chunk.type === "task_update" &&
      !isSlackTurnScopedTaskId(chunk.id) &&
      !onMessage.tasks.has(chunk.id),
  );
  const carried = new Set<string>();
  const frozenRows = new Map<string, string>();
  const intended: AnyChunk[] = [];
  const intendedIds = new Set<string>();
  for (const chunk of retire.full ?? []) {
    if (chunk.type !== "task_update") {
      continue;
    }
    if (chunk.status === "in_progress" && resolveSlackReasoningTaskIndex(chunk.id) === undefined) {
      if (!overflowing) {
        carried.add(chunk.id);
      } else if (onMessage.tasks.has(chunk.id)) {
        frozenRows.set(chunk.id, resolveSlackFrozenRowState(chunk) ?? "");
      }
    }
    if (retire.chunksRejected && retire.previous.tasks.has(chunk.id)) {
      intended.push(chunk);
      intendedIds.add(chunk.id);
    }
  }
  if (retire.chunksRejected) {
    const changes = reconcileSlackNativeTaskChunks({ previous: retire.previous, chunks: intended });
    for (const chunk of changes.chunks ?? []) {
      if (chunk.type === "task_update" && intendedIds.has(chunk.id)) {
        carried.add(chunk.id);
      }
    }
  }
  const retiredTaskIds: string[] = [];
  let rolledThroughCard = 0;
  for (const id of onMessage.tasks.keys()) {
    if (isSlackTurnScopedTaskId(id) || carried.has(id)) {
      continue;
    }
    retiredTaskIds.push(id);
    const card = resolveSlackReasoningTaskIndex(id);
    if (card !== undefined) {
      rolledThroughCard = Math.max(rolledThroughCard, card);
    }
  }
  return { retiredTaskIds, frozenRows, rolledThroughCard };
}

/**
 * Plans the opening of a message of the chain under a fresh message's
 * budget. Text first: a fresh message always takes it, and rows are admitted
 * only beside it (the planner's one-row allowance for an empty message must
 * not put a row next to text that already fills the message). A
 * continuation holds room for pending work before plan rows (see
 * budgetSlackContinuationOpening); the first message shows the whole plan.
 */
export function planSlackMessageOpening(open: {
  chunks: AnyChunk[] | undefined;
  text?: string;
  reserveText?: string;
  reserveFor?: AnyChunk[];
  finalStatus?: "complete" | "error";
  continuation: boolean;
  shownPlanStepIds: ReadonlySet<string>;
}): {
  update: { text?: string; chunks?: AnyChunk[] };
  snapshot: SlackNativeStreamSnapshot;
  textSent: boolean;
  admittedTaskIds: ReadonlySet<string>;
  /** Rows the opening could not take that must carry; plan rows left out are not counted. */
  deferred: boolean;
  /** Plan rows this message shows; undefined when it shows the whole plan. */
  planStepIds: Set<string> | undefined;
} {
  const text = open.text ?? open.reserveText;
  const budgeted = open.continuation
    ? budgetSlackContinuationOpening({
        chunks: open.chunks ?? [],
        reserveFor: open.reserveFor ?? [],
        ...(text ? { text } : {}),
        shownPlanStepIds: open.shownPlanStepIds,
      })
    : undefined;
  const chunks = budgeted?.chunks ?? open.chunks;
  const fresh = new SlackStreamMessageLedger();
  fresh.recordText(text);
  const fit = planSlackStreamUpdateFit(fresh, { chunks });
  const opening = reconcileSlackNativeTaskChunks({
    previous: EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT,
    finalStatus: open.finalStatus,
    chunks: chunks?.filter(
      (chunk) => chunk.type !== "task_update" || fit.admittedTaskIds.has(chunk.id),
    ),
  });
  const textSent = Boolean(open.text);
  const sent = opening.chunks?.length
    ? opening.chunks
    : textSent
      ? undefined
      : [{ type: "plan_update" as const, title: SLACK_REASONING_CONTINUED_TITLE }];
  return {
    update: {
      ...(textSent && open.text ? { text: open.text } : {}),
      ...(sent ? { chunks: sent } : {}),
    },
    snapshot: opening.chunks?.length
      ? opening.snapshot
      : { planTitle: SLACK_REASONING_CONTINUED_TITLE, tasks: new Map() },
    textSent,
    admittedTaskIds: fit.admittedTaskIds,
    deferred: budgeted ? budgeted.deferred : fit.deferredTaskIds.size > 0,
    planStepIds: budgeted?.planStepIds,
  };
}
