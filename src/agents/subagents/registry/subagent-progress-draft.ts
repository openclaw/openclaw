import type { ProgressContinuationDraft } from "../../../channels/progress-continuation.js";
import { onAgentEventForRun, type AgentEventPayload } from "../../../infra/agent-events.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

type ProgressItem = Parameters<ProgressContinuationDraft["push"]>[0];

type LiveDraft = {
  draft: ProgressContinuationDraft;
  /** Announcing children whose completion has not settled yet. */
  children: Set<string>;
  listeners: Map<string, () => void>;
  stopChanges: () => void;
};

// Process-local: the channel transport cannot outlive this Gateway, so a
// replacement never revives a card from stored state.
const liveByChild = new Map<string, LiveDraft>();
const liveByWake = new Map<string, LiveDraft>();

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
    itemId: entry.runId,
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

function follow(live: LiveDraft, runId: string, itemId: string): void {
  live.listeners.set(
    runId,
    onAgentEventForRun(runId, (event) => {
      const item = projectActivity(event, itemId);
      if (item) {
        live.draft.push(item);
      }
    }),
  );
}

function unfollow(live: LiveDraft, runId: string): void {
  live.listeners.get(runId)?.();
  live.listeners.delete(runId);
}

function track(live: LiveDraft, entries: readonly SubagentRunRecord[]): void {
  for (const entry of entries) {
    if (live.children.has(entry.runId)) {
      continue;
    }
    live.children.add(entry.runId);
    liveByChild.set(entry.runId, live);
    follow(live, entry.runId, `${entry.runId}:tool`);
    live.draft.push(projectChild(entry));
  }
}

function retire(live: LiveDraft): void {
  live.stopChanges();
  for (const runId of live.listeners.keys()) {
    unfollow(live, runId);
  }
  for (const runId of live.children) {
    liveByChild.delete(runId);
  }
  live.children.clear();
  live.draft.retire();
}

/**
 * Keep the yielding turn's confirmed draft for its announcing children. The
 * requester settle wake remains the only final-delivery owner; the draft is
 * retired once every tracked child settled or was stopped.
 */
export function adoptSubagentProgressDraft(
  spawns: readonly AcceptedSessionSpawn[],
  draft: ProgressContinuationDraft,
): boolean {
  const candidates = spawns
    .filter((spawn) => spawn.expectsCompletionMessage === true)
    .map(
      (spawn) =>
        [...getSubagentRunsForChildSession(spawn.childSessionKey)]
          .filter((entry) => (entry.taskRunId ?? entry.runId) === spawn.runId)
          .toSorted((a, b) => compareSubagentRunGeneration(b, a))[0],
    );
  const entries = candidates.filter((entry) => entry !== undefined);
  if (
    entries.length === 0 ||
    entries.length !== candidates.length ||
    entries.some(
      (entry) =>
        liveByChild.has(entry.runId) ||
        entry.killIntent ||
        entry.killReconciliation ||
        entry.suppressCompletionDelivery ||
        // A wake that already started cannot report its settlement to this draft.
        entry.requesterSettleWake?.status === "dispatching",
    )
  ) {
    return false;
  }
  const live: LiveDraft = {
    draft,
    children: new Set(),
    listeners: new Map(),
    stopChanges: () => undefined,
  };
  live.stopChanges = subscribeSubagentRunChanges("projection", ({ runIds }) => {
    let present = false;
    for (const runId of live.children) {
      const entry = subagentRuns.get(runId);
      present ||= entry !== undefined;
      if (entry && (!runIds || runIds.includes(runId))) {
        draft.push(projectChild(entry));
      }
    }
    if (!present) {
      retire(live);
    }
  });
  track(live, entries);
  return true;
}

/** Show the resumed requester's work on the same draft while its settle wake runs. */
export async function withSubagentProgressDraft<T>(
  batch: readonly SubagentRunRecord[],
  wakeRunId: string,
  run: () => Promise<T>,
): Promise<T> {
  const live = batch.map((entry) => liveByChild.get(entry.runId)).find(Boolean);
  if (!live) {
    return await run();
  }
  liveByWake.set(wakeRunId, live);
  follow(live, wakeRunId, "requester:tool");
  try {
    return await run();
  } finally {
    unfollow(live, wakeRunId);
    liveByWake.delete(wakeRunId);
  }
}

/** A resumed requester that yields again hands its committed cohort to the same card. */
export function trackSubagentProgressYield(
  requesterTurnRunId: string,
  entries: readonly SubagentRunRecord[],
): void {
  const live = liveByWake.get(requesterTurnRunId);
  if (live && live.children.size > 0) {
    track(live, entries);
  }
}

/** Called after the settle wake authoritatively completes a batch. */
export function settleSubagentProgressDraft(batch: readonly SubagentRunRecord[]): void {
  for (const entry of batch) {
    const live = liveByChild.get(entry.runId);
    if (!live) {
      continue;
    }
    live.children.delete(entry.runId);
    liveByChild.delete(entry.runId);
    unfollow(live, entry.runId);
    if (live.children.size === 0) {
      retire(live);
    }
  }
}

/** Stop and reset close the children's completion, so nothing else retires their draft. */
export function retireSubagentProgressDrafts(entries: readonly SubagentRunRecord[]): void {
  for (const entry of entries) {
    const live = liveByChild.get(entry.runId);
    if (live) {
      retire(live);
    }
  }
}
