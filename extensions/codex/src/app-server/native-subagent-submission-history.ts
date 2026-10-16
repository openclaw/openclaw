import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  findCodexNativeSuccessorTurn,
  readThreadParentThreadId,
} from "./native-subagent-assignment.js";
import type { ChildState, NativeSubagentMonitorClient } from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentRecoveryCoordinator } from "./native-subagent-recovery-coordinator.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export async function readCodexNativeSubmissionTurn(
  receipt: CodexNativeSubagentSubmission,
  dependencies: {
    client: NativeSubagentMonitorClient;
    recovery: Pick<CodexNativeSubagentRecoveryCoordinator, "reconcileRegisteredChild">;
    prepareReceiver: () => boolean;
    isCurrent: () => boolean;
    parentThreadId: () => string;
    currentChild: () => ChildState | undefined;
  },
): Promise<JsonObject | undefined> {
  if (!dependencies.prepareReceiver()) {
    return undefined;
  }
  const response = await dependencies.client.request(
    "thread/read",
    { threadId: receipt.childThreadId, includeTurns: true },
    { timeoutMs: 30_000 },
  );
  if (!dependencies.isCurrent()) {
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
  const turn = findCodexNativeSuccessorTurn(
    turns,
    receipt.predecessorNativeTurnId,
    receipt.submissionId,
  );
  if (!turn) {
    return undefined;
  }
  const previous = dependencies.currentChild();
  if (previous && !previous.terminal && previous.nativeTurnId !== receipt.submissionId) {
    await dependencies.recovery.reconcileRegisteredChild(previous);
  }
  return dependencies.isCurrent() ? turn : undefined;
}
