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
 * How each plan step rendered on the last message that showed it, by task
 * id: title, status, details and output, so a revised title counts as a
 * change just like a new status.
 */
export type SlackShownPlanSteps = Map<string, string>;

function resolveSlackPlanStepRendering(row: {
  title: string;
  status: TaskUpdateChunk["status"];
  details?: string;
  output?: string;
}): string {
  return JSON.stringify([row.title, row.status, row.details ?? "", row.output ?? ""]);
}

/** A plan step no message has shown in its current state (never shown, or changed since). */
function isSlackPlanStepUnshown(row: TaskUpdateChunk, shown: SlackShownPlanSteps): boolean {
  return shown.get(row.id) !== resolveSlackPlanStepRendering(row);
}

function buildSlackPlanRows(plan: SlackPlanRowsSource): TaskUpdateChunk[] {
  return (buildSlackProgressStreamChunks({ lines: [], ...plan }) ?? []).filter(
    (chunk): chunk is TaskUpdateChunk => isTaskUpdate(chunk) && isSlackPlanStepTaskId(chunk.id),
  );
}

/**
 * Order in which plan rows take the slots a message has left for them:
 * running steps, then steps not started, then completed ones, and within
 * each group steps no message has shown yet before steps whose status
 * changed since a message showed them, in step order. A step a message
 * already shows in its current state is not repeated.
 */
function prioritizeSlackPlanRows(
  rows: readonly TaskUpdateChunk[],
  shown: SlackShownPlanSteps,
): TaskUpdateChunk[] {
  const rank = (row: TaskUpdateChunk) =>
    row.status === "in_progress" ? 0 : row.status === "complete" ? 2 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => isSlackPlanStepUnshown(entry.row, shown))
    .toSorted(
      (left, right) =>
        rank(left.row) - rank(right.row) ||
        Number(shown.has(left.row.id)) - Number(shown.has(right.row.id)) ||
        left.index - right.index,
    )
    .map((entry) => entry.row);
}

/**
 * Fits the opening of a continuation under a fresh message's budget with
 * capacity for pending work first: the text (or room for it), the rows
 * that must carry, the pending cards the runtime will release next, and
 * only then plan rows in priority order. Plan rows that do not fit wait
 * for the next continuation, which the chain opens for them (see
 * `countUnshownPlanSteps`); they are not deferred work.
 */
function budgetSlackContinuationOpening(open: {
  chunks: readonly AnyChunk[];
  /** Rows to hold room for that are not sent with the opening (queued cards). */
  reserveFor: readonly AnyChunk[];
  text?: string;
  shownPlanSteps: SlackShownPlanSteps;
  taskLimit: number;
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
  const fresh = new SlackStreamMessageLedger(open.taskLimit);
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
      ...prioritizeSlackPlanRows(planRows, open.shownPlanSteps),
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

/**
 * Closeout of a message that rolls: the "continued below" title and every
 * row it holds or takes with the closeout, running ones painted complete
 * (closing the message does not finish their tools; the chain carries them).
 */
export function planSlackRolloverCloseout(roll: {
  previous: SlackNativeStreamSnapshot;
  full: AnyChunk[] | undefined;
  admittedTaskIds?: ReadonlySet<string>;
  title: string;
}) {
  const kept: AnyChunk[] = [{ type: "plan_update", title: roll.title }];
  for (const chunk of roll.full ?? []) {
    if (
      chunk.type === "task_update" &&
      (roll.previous.tasks.has(chunk.id) || roll.admittedTaskIds?.has(chunk.id))
    ) {
      kept.push(chunk.status === "in_progress" ? { ...chunk, status: "complete" } : chunk);
    }
  }
  return reconcileSlackNativeTaskChunks({
    previous: roll.previous,
    finalStatus: "complete",
    chunks: kept,
  });
}

/**
 * Reason a message rolled, for the roll log: a budget roll with every row
 * slot taken (rows on the message plus rows admitted with its closeout) is a
 * roll on rows.
 */
export function resolveSlackRollReason(
  roll: { reason: string; admittedTaskIds?: ReadonlySet<string> },
  ledger: SlackStreamMessageLedger,
): string {
  const unrecorded = [...(roll.admittedTaskIds ?? [])].filter((id) => !ledger.hasTask(id)).length;
  return roll.reason === "budget" && ledger.taskCount + unrecorded >= ledger.taskLimit
    ? "rows"
    : roll.reason;
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

type SlackPlanRowsSource = {
  plan: readonly AgentPlanStep[] | undefined;
  maxLineChars: number;
  summaryRow: boolean;
};

/**
 * Authored plan steps across one turn's chain of messages. The first message
 * shows the whole plan; a continuation shows the plan rows chosen when it
 * opened. A step a message already shows in its current state is not
 * repeated, and no step is dropped: while a step left out of the current
 * continuation has not been on a message as it stands, the chain owes it
 * another continuation.
 */
export class SlackChainPlanSteps {
  /** Plan rows the current continuation shows; undefined on the first message and between messages. */
  onMessage: Set<string> | undefined;
  /** How each step rendered on the last message that showed it. */
  readonly shown: SlackShownPlanSteps = new Map();

  /** Whether a task row may go on the current message. */
  admits(id: string): boolean {
    return !this.onMessage || !isSlackPlanStepTaskId(id) || this.onMessage.has(id);
  }

  /** Records the plan rows a finished message holds. */
  retire(tasks: SlackNativeStreamSnapshot["tasks"]): void {
    for (const [id, task] of tasks) {
      if (isSlackPlanStepTaskId(id)) {
        this.shown.set(
          id,
          resolveSlackPlanStepRendering({
            title: task.title,
            status: task.status,
            details: task.details?.source,
            output: task.output?.source,
          }),
        );
      }
    }
  }

  /** Plan steps the chain still owes a message; zero on the first message. */
  countOwed(source: SlackPlanRowsSource): number {
    const onMessage = this.onMessage;
    return onMessage
      ? buildSlackPlanRows(source).filter(
          (row) => !onMessage.has(row.id) && isSlackPlanStepUnshown(row, this.shown),
        ).length
      : 0;
  }

  /**
   * Lets plan rows the continuation left out onto it, in priority order as
   * far as they fit beside what it holds, the text to come and the queued
   * cards it must still take: a step whose status or title changed since a
   * message showed it then lands here instead of being skipped or opening
   * another continuation, and the last message shows those changes too.
   */
  admitUnshown(
    source: SlackPlanRowsSource & {
      ledger: SlackStreamMessageLedger;
      reserveText?: string;
      reserveFor?: readonly AnyChunk[];
    },
  ): void {
    const onMessage = this.onMessage;
    const candidates = onMessage
      ? buildSlackPlanRows(source).filter((row) => !onMessage.has(row.id))
      : [];
    if (!onMessage || candidates.length === 0) {
      return;
    }
    const plan = prioritizeSlackPlanRows(candidates, this.shown);
    if (plan.length === 0) {
      return;
    }
    const fit = planSlackStreamUpdateFit(source.ledger, {
      ...(source.reserveText ? { text: source.reserveText } : {}),
      chunks: [...(source.reserveFor ?? []), ...plan],
    });
    for (const row of plan) {
      if (fit.admittedTaskIds.has(row.id)) {
        onMessage.add(row.id);
      }
    }
  }
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
  shownPlanSteps: SlackShownPlanSteps;
  /** Task rows a message may hold (see SlackStreamMessageLedger.taskLimit). */
  taskLimit: number;
}): {
  update: { text?: string; chunks: AnyChunk[] };
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
        shownPlanSteps: open.shownPlanSteps,
        taskLimit: open.taskLimit,
      })
    : undefined;
  const chunks = budgeted?.chunks ?? open.chunks;
  const fresh = new SlackStreamMessageLedger(open.taskLimit);
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
      // Explicit empty chunks make the SDK send a text-only opening at once;
      // text alone stays in its buffer and Slack never acknowledges the start.
      chunks: sent ?? [],
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
