import type { ProgressContinuationDraft } from "../../../channels/progress-continuation.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../../infra/agent-events.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { getSubagentRunsForChildSession } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { latestSubagentRun } from "./subagent-run-generation.js";

type ProgressItem = Parameters<ProgressContinuationDraft["push"]>[0];

type Member = {
  childSessionKey: string;
  childAgentId?: string;
  /** Last observed current execution of this logical task. */
  row: SubagentRunRecord;
  stopEvents: () => void;
};

type LiveDraft = {
  draft: ProgressContinuationDraft;
  /** Announcing tasks, by logical task id, whose result the requester is still owed. */
  members: Map<string, Member>;
  stopChanges: () => void;
};

// Process-local: the channel transport cannot outlive this Gateway, so a
// replacement never revives a card from stored state.
const liveByTask = new Map<string, LiveDraft>();
const liveByWake = new Map<string, LiveDraft>();

const taskId = (entry: SubagentRunRecord) => entry.taskRunId ?? entry.runId;

/**
 * The requester settle wake still owes this task's result to its requester. A
 * kill intent can still roll back, so only accepted cancellation ends the debt.
 */
function owesCompletion(entry: SubagentRunRecord | undefined): entry is SubagentRunRecord {
  return (
    entry?.requesterSettleWake !== undefined &&
    entry.suppressCompletionDelivery !== true &&
    entry.killReconciliation?.suppressTaskDelivery !== true
  );
}

/** Steering and resumed yields replace a task's execution under the same task id. */
function currentRow(
  id: string,
  childSessionKey: string,
  childAgentId?: string,
): SubagentRunRecord | undefined {
  return latestSubagentRun(
    getSubagentRunsForChildSession(childSessionKey, childAgentId),
    (entry) => taskId(entry) === id,
  );
}

/** Only prepared operation names and outcomes cross a private child's audience boundary. */
function projectActivity(event: AgentEventPayload, itemId: string): ProgressItem | undefined {
  const { data } = event;
  if (
    event.stream !== "item" ||
    data.kind !== "tool" ||
    data.hideFromChannelProgress === true ||
    data.suppressChannelProgress === true ||
    typeof data.name !== "string" ||
    !/^[\w.:-]{1,120}$/.test(data.name) ||
    typeof data.status !== "string" ||
    !["running", "completed", "failed", "blocked", "skipped"].includes(data.status)
  ) {
    return undefined;
  }
  const status = data.status;
  return {
    itemId,
    kind: "tool",
    name: data.name,
    phase: status === "running" ? "update" : "end",
    status,
  };
}

function projectChild(entry: SubagentRunRecord): ProgressItem {
  const paused = entry.pauseReason === "sessions_yield";
  const ended = entry.execution.status === "terminal" && !paused;
  const outcome = ended ? entry.execution.outcome?.status : undefined;
  return {
    itemId: taskId(entry),
    kind: "subagent",
    title: (entry.label ?? entry.taskName ?? "Delegated work").slice(0, 120),
    phase: ended ? "end" : "update",
    status:
      outcome === "ok"
        ? "completed"
        : outcome === "error" || outcome === "timeout"
          ? "failed"
          : ended || paused
            ? undefined
            : "running",
    summary: paused ? "waiting" : ended && !outcome ? "outcome unknown" : undefined,
  };
}

function follow(live: LiveDraft, runId: string, itemId: string): () => void {
  return onAgentEventForRun(runId, (event) => {
    const item = projectActivity(event, itemId);
    if (item) {
      live.draft.push(item);
    }
  });
}

function track(live: LiveDraft, entries: readonly SubagentRunRecord[]): void {
  for (const entry of entries) {
    const id = taskId(entry);
    if (live.members.has(id) || !owesCompletion(entry)) {
      continue;
    }
    live.members.set(id, {
      childSessionKey: entry.childSessionKey,
      childAgentId: entry.childAgentId,
      row: entry,
      stopEvents: follow(live, entry.runId, `${id}:tool`),
    });
    liveByTask.set(id, live);
    live.draft.push(projectChild(entry));
  }
}

function drop(live: LiveDraft, id: string): void {
  live.members.get(id)?.stopEvents();
  live.members.delete(id);
  liveByTask.delete(id);
}

function retire(live: LiveDraft): void {
  live.stopChanges();
  for (const id of live.members.keys()) {
    drop(live, id);
  }
  live.draft.retire();
}

/**
 * Settlement, retries, stop, reset and replacement all commit through registry
 * publications, so the draft follows committed task state rather than callers.
 */
function reconcile(live: LiveDraft): void {
  for (const [id, member] of live.members) {
    const row = currentRow(id, member.childSessionKey, member.childAgentId);
    if (row === member.row) {
      continue;
    }
    if (!owesCompletion(row)) {
      drop(live, id);
      continue;
    }
    if (row.runId !== member.row.runId) {
      member.stopEvents();
      member.stopEvents = follow(live, row.runId, `${id}:tool`);
    }
    member.row = row;
    live.draft.push(projectChild(row));
  }
  if (live.members.size === 0) {
    retire(live);
  }
}

/**
 * Keep the yielding turn's confirmed draft for its announcing children. The
 * requester settle wake remains the only final-delivery owner; the draft is
 * retired once no tracked task is owed to the requester anymore.
 */
export function adoptSubagentProgressDraft(
  spawns: readonly AcceptedSessionSpawn[],
  draft: ProgressContinuationDraft,
): boolean {
  const entries = spawns
    .filter((spawn) => spawn.expectsCompletionMessage === true)
    .map((spawn) => currentRow(spawn.runId, spawn.childSessionKey));
  if (
    entries.length === 0 ||
    !entries.every(owesCompletion) ||
    entries.some(
      (entry) =>
        liveByTask.has(taskId(entry)) ||
        entry.killIntent ||
        entry.killReconciliation ||
        // A wake that already started cannot report a re-yield to this draft.
        entry.requesterSettleWake?.status === "dispatching",
    )
  ) {
    return false;
  }
  const live: LiveDraft = { draft, members: new Map(), stopChanges: () => undefined };
  live.stopChanges = subscribeSubagentRunChanges("projection", () => reconcile(live));
  track(live, entries);
  return true;
}

/** Show the resumed requester's work on the same draft while its settle wake runs. */
export async function withSubagentProgressDraft<T>(
  batch: readonly SubagentRunRecord[],
  wakeRunId: string,
  run: () => Promise<T>,
): Promise<T> {
  const live = batch.map((entry) => liveByTask.get(taskId(entry))).find(Boolean);
  if (!live) {
    return await run();
  }
  liveByWake.set(wakeRunId, live);
  const stopEvents = follow(live, wakeRunId, "requester:tool");
  try {
    return await run();
  } finally {
    stopEvents();
    liveByWake.delete(wakeRunId);
  }
}

/** A resumed requester that yields again hands its committed cohort to the same card. */
export function trackSubagentProgressYield(
  requesterTurnRunId: string,
  entries: readonly SubagentRunRecord[],
): void {
  const live = liveByWake.get(requesterTurnRunId);
  if (live && live.members.size > 0) {
    track(live, entries);
  }
}
