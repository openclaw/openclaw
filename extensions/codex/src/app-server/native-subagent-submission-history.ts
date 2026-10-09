import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readThreadParentThreadId } from "./native-subagent-assignment.js";
import type { ChildState, NativeSubagentMonitorClient } from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentRecoveryCoordinator } from "./native-subagent-recovery-coordinator.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export async function readCodexNativeSubmissionTurn(
  receipt: CodexNativeSubagentSubmission,
  dependencies: {
    client: NativeSubagentMonitorClient;
    recovery: Pick<
      CodexNativeSubagentRecoveryCoordinator,
      "retainThreadStatusRevision" | "reconcileRegisteredChild"
    >;
    prepareReceiver: () => boolean;
    isCurrent: () => boolean;
    parentThreadId: () => string;
    currentChild: () => ChildState | undefined;
  },
): Promise<JsonObject | undefined> {
  if (!dependencies.prepareReceiver()) {
    return undefined;
  }
  const revision = dependencies.recovery.retainThreadStatusRevision(receipt.childThreadId);
  try {
    const response = await dependencies.client.request(
      "thread/read",
      { threadId: receipt.childThreadId, includeTurns: true },
      { timeoutMs: 30_000 },
    );
    if (!revision.isCurrent() || !dependencies.isCurrent()) {
      return undefined;
    }
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (
      readString(thread, "id") !== receipt.childThreadId ||
      readThreadParentThreadId(thread) !== dependencies.parentThreadId()
    ) {
      return undefined;
    }
    const turns = (Array.isArray(thread?.turns) ? thread.turns : []).flatMap((turn) =>
      isJsonObject(turn) ? [turn] : [],
    );
    const predecessorIndex = turns.findIndex(
      (turn) => readString(turn, "id") === receipt.predecessorNativeTurnId,
    );
    const turnIndex = turns.findIndex((turn) => readString(turn, "id") === receipt.submissionId);
    if (
      predecessorIndex < 0 ||
      turnIndex <= predecessorIndex ||
      !["completed", "failed"].includes(readString(turns[predecessorIndex], "status") ?? "")
    ) {
      return undefined;
    }
    const previous = dependencies.currentChild();
    if (previous && !previous.terminal && previous.nativeTurnId !== receipt.submissionId) {
      await dependencies.recovery.reconcileRegisteredChild(previous);
    }
    return dependencies.isCurrent() ? turns[turnIndex] : undefined;
  } finally {
    revision.release();
  }
}
