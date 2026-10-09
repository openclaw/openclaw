import type {
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { cliBackendLog } from "./log.js";

/** Native acceptance owns replay safety; transcript settlement releases input custody. */
export async function queueSteeredCliUserTurn(
  inject: () => Promise<void>,
  options: ReplyBackendQueueMessageOptions | undefined,
  cwd: string,
): Promise<ReplyBackendQueueMessageResult | undefined> {
  let accepted = false;
  let failure: Error | undefined;
  let result: ReplyBackendQueueMessageResult | undefined;
  try {
    await inject();
    accepted = true;
    options?.onQueueAccepted?.(true);
    const recorder = options?.userTurnTranscriptRecorder;
    if (recorder && !recorder.hasPersisted() && !recorder.isBlocked()) {
      const persisted = await recorder.persistApproved({ cwd });
      if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
        // Native owns the input, but an absent receipt does not prove write rejection.
        // Suppress outer fallback persistence without canceling independent active work.
        recorder.markBlocked();
        result = {
          transcriptCommit: "unconfirmed",
          errorMessage: "steered CLI user turn transcript commitment could not be confirmed",
        };
      }
    }
  } catch (error) {
    failure = toErrorObject(error, "CLI steering failed.");
  }
  try {
    // This receipt is terminal even when persistence failed; the registry retains
    // accepted-input disposition without replaying or canceling an unconfirmed turn.
    options?.onQueueSettled?.();
  } catch (error) {
    failure ??= toErrorObject(error, "CLI steering completion observer failed.");
  }
  if (failure) {
    if (!accepted) {
      throw failure;
    }
    // Completion observers can throw too. Never downgrade native acceptance to rejection.
    const errorMessage = `steered CLI user turn was not settled: ${formatErrorMessage(failure)}`;
    cliBackendLog.warn(errorMessage);
    return { transcriptCommit: "unconfirmed", errorMessage };
  }
  return result;
}
