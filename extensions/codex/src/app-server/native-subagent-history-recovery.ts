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
  ChildState,
  KnownChild,
  NativeSubagentMonitorClient,
  NativeTurnEnd,
  NativeTurnState,
  RecoveredCompletion,
  ThreadRecovery,
} from "./native-subagent-monitor-types.js";
import type { CodexTurn, JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const THREAD_READ_TIMEOUT_MS = 30_000;

export class CodexNativeSubagentHistoryRecovery {
  constructor(
    private readonly client: Pick<NativeSubagentMonitorClient, "request">,
    private readonly knownChildren: ReadonlyMap<string, KnownChild>,
    private readonly children: ReadonlyMap<string, ChildState>,
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

  async read(
    assignment: NativeSubagentAssignment,
    options: {
      resumeInterrupted: boolean;
      predecessorNativeTurnId?: string;
      initialAssignment?: boolean;
      recordedCompletion?: RecoveredCompletion;
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
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    if (options.predecessorNativeTurnId) {
      const turns = rawTurns.filter(isJsonObject);
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
    let initialTurnId: string | undefined;
    if (options.initialAssignment && !assignment.nativeTurnId && !recordedCompletion) {
      const forkedFromId = readString(thread, "forkedFromId");
      // Fork history contains a parent's immutable prefix, not child results.
      // Only an observed turn or native completion receipt can anchor that child.
      initialTurnId = forkedFromId
        ? undefined
        : readString(
            rawTurns.find((turn) => readString(turn, "id")),
            "id",
          );
      if (!initialTurnId) {
        return {
          parentThreadId: readThreadParentThreadId(thread),
          resumable: false,
          threadState: "unavailable",
          observedPendingTurns: [],
        };
      }
    }
    const turnId = assignment.nativeTurnId ?? initialTurnId;
    const pendingTurnIds = new Set(
      this.knownChildren.get(childThreadId)?.pendingTurns.map((turn) => turn.turnId) ?? [],
    );
    const unresolvedAssignment = options.resumeInterrupted && !turnId && pendingTurnIds.size > 0;
    const observedPendingTurns: ThreadRecovery["observedPendingTurns"] = [];
    for (const turn of rawTurns) {
      const pendingTurnId = readString(turn, "id");
      if (pendingTurnId && pendingTurnIds.has(pendingTurnId)) {
        observedPendingTurns.push({ turnId: pendingTurnId, state: readNativeTurnState(turn) });
      }
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let recovery = readTurnRecovery(undefined, childThreadId);
    let fallbackCompletion: RecoveredCompletion | undefined;
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
      const turns = rawTurns.filter(isJsonObject);
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
      recovery = readTurnRecovery(turn, childThreadId);
      threadState = turnStatus === "inprogress" ? "active" : turnStatus ? "other" : "unavailable";
    } else if (threadStatus === "active") {
      const turn = rawTurns.at(-1);
      if (normalizeIdentifier(readString(turn, "status")) === "inprogress") {
        recovery.nativeTurnId = readString(turn, "id");
        recovery.nativeTurnState = "active";
      }
    } else if (threadStatus !== "systemerror") {
      recovery = readTurnRecovery(rawTurns.findLast(isJsonObject), childThreadId);
    }
    if (
      !unresolvedAssignment &&
      threadStatus === "systemerror" &&
      (!turnId || (threadState === "unavailable" && !recovery.completion))
    ) {
      // The pinned protocol's paged history distinguishes the failed current
      // turn from earlier persisted results.
      const turnsResponse = await this.client
        .request(
          "thread/turns/list",
          { threadId: childThreadId, limit: 1, sortDirection: "desc", itemsView: "full" },
          { timeoutMs: THREAD_READ_TIMEOUT_MS },
        )
        .catch(() => undefined);
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
          recovery = readTurnRecovery(latestTurn, childThreadId);
        } else if (latestTurnStatus === "failed") {
          recovery.completion = readTurnCompletion(latestTurn, childThreadId);
        }
      }
      const current = !latestTurn ? this.knownChildren.get(childThreadId)?.assignment : undefined;
      const unresolvedCurrentAssignment =
        current?.runId === assignment.runId &&
        this.children.get(current.runId)?.nativeTurnState !== "completed";
      if (latestTurnStatus === "inprogress" && matchesAssignment) {
        recovery.nativeTurnId = readString(latestTurn, "id");
        recovery.nativeTurnState = "active";
        threadState = "active";
      } else if (
        !recovery.completion &&
        !recovery.resumable &&
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
      (!turnId || !recovery.completion || recovery.completion.status !== recordedCompletion.status)
    ) {
      recovery.completion = recordedCompletion;
      if (!turnId) {
        recovery.nativeTurnId = undefined;
        recovery.nativeTurnState = undefined;
      }
      fallbackCompletion = undefined;
      recovery.resumable = false;
      threadState = "other";
    }
    return {
      parentThreadId: readThreadParentThreadId(thread),
      agentPath: normalizeOptionalString(readString(readThreadSpawnSource(thread), "agent_path")),
      nativeTurnId: recovery.nativeTurnId,
      nativeTurnState: recovery.nativeTurnState,
      observedPendingTurns,
      completion: recovery.completion,
      fallbackCompletion,
      resumable: recovery.resumable,
      threadState,
    };
  }
}

function readTurnRecovery(
  turn: CodexTurn | JsonObject | undefined,
  childThreadId: string,
): Pick<ThreadRecovery, "completion" | "resumable" | "nativeTurnId" | "nativeTurnState"> {
  return turn
    ? {
        nativeTurnId: readString(turn, "id"),
        nativeTurnState: readNativeTurnState(turn),
        completion: isJsonObject(turn) ? readTurnCompletion(turn, childThreadId) : undefined,
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
  if (status === "failed") {
    const error = isJsonObject(turn.error) ? turn.error : undefined;
    return {
      childThreadId,
      status: "failed",
      statusLabel: source === "history" ? "task_failed" : "turn_failed",
      result:
        normalizeOptionalString(readString(error, "message")) ??
        normalizeOptionalString(
          isJsonObject(error?.codexErrorInfo)
            ? readString(error.codexErrorInfo, "message")
            : undefined,
        ) ??
        (source === "history" ? result : undefined) ??
        "Subagent failed.",
      ...timestamp,
    };
  }
  // Interrupted subagents remain resumable until a later authoritative terminal turn.
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
