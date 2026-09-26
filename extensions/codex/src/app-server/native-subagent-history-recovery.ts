import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeIdentifier,
  readThreadParentThreadId,
  readThreadSpawnSource,
  type NativeSubagentAssignment,
} from "./native-subagent-assignment.js";
import type {
  NativeSubagentMonitorClient,
  NativeTurnEnd,
  NativeTurnObservation,
  NativeTurnState,
  RecoveredCompletion,
  ThreadRecovery,
} from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentCurrentAssignmentState = {
  runId: string | undefined;
  nativeTurnState: NativeTurnState | undefined;
};

type NativeSubagentHistoryQueries = {
  getPendingTurnIds: (childThreadId: string) => readonly string[];
  getCurrentAssignmentState: (
    childThreadId: string,
  ) => NativeSubagentCurrentAssignmentState | undefined;
};

const THREAD_READ_TIMEOUT_MS = 30_000;

export class CodexNativeSubagentHistoryRecovery {
  constructor(
    private readonly client: Pick<NativeSubagentMonitorClient, "request">,
    private readonly queries: NativeSubagentHistoryQueries,
  ) {}

  private requestThreadRead(childThreadId: string, includeTurns: boolean) {
    return this.client.request(
      "thread/read",
      {
        threadId: childThreadId,
        includeTurns,
      },
      {
        timeoutMs: THREAD_READ_TIMEOUT_MS,
      },
    );
  }

  private requestLatestThreadTurn(childThreadId: string) {
    return this.client.request(
      "thread/turns/list",
      {
        threadId: childThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: THREAD_READ_TIMEOUT_MS },
    );
  }

  async read(
    assignment: NativeSubagentAssignment,
    options: {
      resumeInterrupted: boolean;
      predecessorNativeTurnId?: string;
      initialAssignment?: boolean;
      recordedCompletion?: RecoveredCompletion;
      observedTurns?: readonly NativeTurnObservation[];
    },
  ): Promise<ThreadRecovery> {
    const { childThreadId } = assignment;
    const { recordedCompletion } = options;
    // Fresh threads can expose lineage before includeTurns history is materialized.
    // Register that lineage now so the normal child backoff owns later full reads.
    const response = await this.requestThreadRead(childThreadId, true).catch(() =>
      this.requestThreadRead(childThreadId, false),
    );
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (!thread || readString(thread, "id")?.trim() !== childThreadId) {
      return { resumable: false, threadState: "unavailable", observedPendingTurns: [] };
    }
    if (options.predecessorNativeTurnId) {
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isJsonObject) : [];
      const predecessor = turns.findIndex(
        (turn) => readString(turn, "id") === options.predecessorNativeTurnId,
      );
      const target = turns.findIndex((turn) => readString(turn, "id") === assignment.nativeTurnId);
      if (
        predecessor < 0 ||
        target <= predecessor ||
        !["completed", "failed"].includes(readString(turns[predecessor], "status") ?? "")
      ) {
        return { resumable: false, threadState: "unavailable", observedPendingTurns: [] };
      }
    }
    const firstObserved = options.observedTurns?.[0];
    // Forked history can begin with copied parent turns. Only a native child
    // end observed before successor starts can anchor an unlocated predecessor.
    const observedPredecessor =
      options.resumeInterrupted &&
      firstObserved?.state &&
      firstObserved.state !== "active" &&
      !firstObserved.startObserved
        ? firstObserved.turnId
        : undefined;
    let initialTurnId: string | undefined;
    if (options.initialAssignment && !assignment.nativeTurnId && !recordedCompletion) {
      const forkedFromId = readString(thread, "forkedFromId");
      if (forkedFromId) {
        // Codex snapshots inherited history at fork time. A later parent read
        // reflects rollback, not that immutable prefix; subtraction can label a
        // copied parent final as child output. Wait for an observed child turn
        // or native completion receipt instead of inventing its first turn.
        return {
          parentThreadId: readThreadParentThreadId(thread),
          resumable: false,
          threadState: "unavailable",
          observedPendingTurns: [],
        };
      }
      for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
        const id = readString(turn, "id");
        if (id) {
          initialTurnId = id;
          break;
        }
      }
      if (!initialTurnId) {
        return {
          parentThreadId: readThreadParentThreadId(thread),
          resumable: false,
          threadState: "unavailable",
          observedPendingTurns: [],
        };
      }
    }
    const turnId = assignment.nativeTurnId ?? initialTurnId ?? observedPredecessor;
    const pendingTurnIds = new Set([
      ...this.queries.getPendingTurnIds(childThreadId),
      ...(options.observedTurns?.map((turn) => turn.turnId) ?? []),
    ]);
    const unresolvedAssignment = options.resumeInterrupted && !turnId && pendingTurnIds.size > 0;
    const observedPendingTurns: ThreadRecovery["observedPendingTurns"] = [];
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      const pendingTurnId = readString(turn, "id");
      if (pendingTurnId && pendingTurnIds.has(pendingTurnId)) {
        observedPendingTurns.push({ turnId: pendingTurnId, state: readNativeTurnState(turn) });
      }
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let completion: RecoveredCompletion | undefined;
    let fallbackCompletion: RecoveredCompletion | undefined;
    let nativeTurnId: string | undefined;
    let nativeTurnState: NativeTurnState | undefined;
    let resumable = false;
    let threadState: ThreadRecovery["threadState"] =
      threadStatus === "active"
        ? "active"
        : threadStatus === "systemerror"
          ? "system_error"
          : threadStatus
            ? "other"
            : "unavailable";
    if (unresolvedAssignment) {
      threadState = "unavailable";
    } else if (turnId) {
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isJsonObject) : [];
      let index = turns.findIndex((turn) => readString(turn, "id") === turnId);
      // A missed resume notification can leave an unfinished assignment on an
      // interrupted turn. Stop at its first terminal turn, before any later assignment.
      while (
        options.resumeInterrupted &&
        index >= 0 &&
        index + 1 < turns.length &&
        normalizeIdentifier(readString(turns[index], "status")) === "interrupted"
      ) {
        index += 1;
      }
      const turn = turns[index];
      const turnStatus = normalizeIdentifier(readString(turn, "status"));
      nativeTurnId = readString(turn, "id");
      nativeTurnState = readNativeTurnState(turn);
      completion = isJsonObject(turn) ? readTurnCompletion(turn, childThreadId) : undefined;
      resumable = turnStatus === "interrupted";
      threadState = turnStatus === "inprogress" ? "active" : turnStatus ? "other" : "unavailable";
    } else if (threadStatus === "active") {
      const turn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
      if (normalizeIdentifier(readString(turn, "status")) === "inprogress") {
        nativeTurnId = readString(turn, "id");
        nativeTurnState = "active";
      }
    } else if (threadStatus !== "systemerror") {
      const turnRecovery = readThreadTurnRecovery(thread, childThreadId);
      nativeTurnId = turnRecovery.nativeTurnId;
      nativeTurnState = turnRecovery.nativeTurnState;
      completion = turnRecovery.completion;
      resumable = turnRecovery.resumable;
    }
    if (
      !unresolvedAssignment &&
      threadStatus === "systemerror" &&
      (!turnId || (threadState === "unavailable" && !completion))
    ) {
      // The pinned protocol's paged history distinguishes the failed current
      // turn from earlier persisted results.
      const turnsResponse = await this.requestLatestThreadTurn(childThreadId).catch(
        () => undefined,
      );
      const data =
        isJsonObject(turnsResponse) && Array.isArray(turnsResponse.data) ? turnsResponse.data : [];
      const latestTurn = isJsonObject(data[0]) ? data[0] : undefined;
      const latestTurnId = readString(latestTurn, "id");
      if (latestTurnId && pendingTurnIds.has(latestTurnId)) {
        observedPendingTurns.push({ turnId: latestTurnId, state: readNativeTurnState(latestTurn) });
      }
      const latestTurnStatus = normalizeIdentifier(readString(latestTurn, "status"));
      const matchesAssignment = !turnId || readString(latestTurn, "id") === turnId;
      if (latestTurn && matchesAssignment) {
        if (turnId) {
          const turnRecovery = readThreadTurnRecovery({ turns: [latestTurn] }, childThreadId);
          nativeTurnId = turnRecovery.nativeTurnId;
          nativeTurnState = turnRecovery.nativeTurnState;
          completion = turnRecovery.completion;
          resumable = turnRecovery.resumable;
        } else if (latestTurnStatus === "failed") {
          completion = readTurnCompletion(latestTurn, childThreadId);
        }
      }
      const current = !latestTurn
        ? this.queries.getCurrentAssignmentState(childThreadId)
        : undefined;
      const unresolvedCurrentAssignment =
        current?.runId === assignment.runId && current?.nativeTurnState !== "completed";
      if (latestTurnStatus === "inprogress" && matchesAssignment) {
        nativeTurnId = readString(latestTurn, "id");
        nativeTurnState = "active";
        threadState = "active";
      } else if (
        !completion &&
        !resumable &&
        latestTurnStatus !== "inprogress" &&
        (!turnId || (!latestTurn && unresolvedCurrentAssignment))
      ) {
        // A missing live snapshot must still settle: retry briefly, then report
        // the current assignment's error without failing an older pending result.
        fallbackCompletion = systemErrorFallbackCompletion(childThreadId);
      }
    }
    if (
      recordedCompletion &&
      (!turnId || !completion || completion.status !== recordedCompletion.status)
    ) {
      completion = recordedCompletion;
      if (!turnId) {
        nativeTurnId = undefined;
        nativeTurnState = undefined;
      }
      fallbackCompletion = undefined;
      resumable = false;
      threadState = "other";
    }
    const lineage = {
      parentThreadId: readThreadParentThreadId(thread),
      agentPath: normalizeOptionalString(readString(readThreadSpawnSource(thread), "agent_path")),
    };
    return {
      ...lineage,
      assignmentTurnId: turnId,
      nativeTurnId,
      nativeTurnState,
      observedPendingTurns,
      completion,
      fallbackCompletion,
      resumable,
      threadState,
    };
  }
}

function readThreadTurnRecovery(
  thread: JsonObject,
  childThreadId: string,
): Pick<ThreadRecovery, "completion" | "resumable" | "nativeTurnId" | "nativeTurnState"> {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns.findLast(isJsonObject);
  return turn
    ? {
        nativeTurnId: readString(turn, "id"),
        nativeTurnState: readNativeTurnState(turn),
        completion: readTurnCompletion(turn, childThreadId),
        resumable: normalizeIdentifier(readString(turn, "status")) === "interrupted",
      }
    : { resumable: false };
}

export function readNativeTurnEnd(
  turn: Record<string, unknown> | undefined,
): NativeTurnEnd | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  return status === "completed" || status === "failed" || status === "interrupted"
    ? status
    : undefined;
}

function readNativeTurnState(
  turn: Record<string, unknown> | undefined,
): NativeTurnState | undefined {
  return normalizeIdentifier(readString(turn, "status")) === "inprogress"
    ? "active"
    : readNativeTurnEnd(turn);
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

export function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Subagent runtime reported a system error.",
  };
}

export function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
  source: "history" | "notification" = "history",
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const timestamp =
    source === "history"
      ? {
          completedAt:
            completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000),
        }
      : {};
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result
        ? source === "history"
          ? "task_complete"
          : "turn_completed"
        : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
      ...timestamp,
    };
  }
  // Codex keeps interrupted subagents resumable. They remain a running task
  // until a later turn reaches an authoritative terminal state.
  if (status === "interrupted") {
    return undefined;
  }
  if (status === "failed") {
    return {
      childThreadId,
      status: "failed",
      statusLabel: source === "history" ? "task_failed" : "turn_failed",
      result:
        readTurnErrorMessage(turn) ??
        (source === "history" ? result : undefined) ??
        "Subagent failed.",
      ...timestamp,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

export function isNoFinalCompletion(completion: CodexNativeSubagentCompletion): boolean {
  return (
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message"
  );
}
