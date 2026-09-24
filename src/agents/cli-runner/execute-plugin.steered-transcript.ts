import type {
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cliBackendLog } from "./log.js";

/**
 * Records a steered user turn once the native runtime has started it.
 *
 * The embedded runtime appends steered input to the session transcript itself;
 * a CLI owns its native transcript, so without this the input reaches the model
 * and the native session but not OpenClaw's transcript, memory search or history.
 *
 * The input is already in the model's hands, so a failure here is never a
 * rejection: replaying it would run the same text as a second turn. It is
 * reported as an unconfirmed commit instead, which keeps custody of the
 * non-replayable input with the registry and stops the captured run rather than
 * letting an unrecorded turn pass for a committed one.
 */
export async function persistSteeredCliUserTurn(
  options: ReplyBackendQueueMessageOptions | undefined,
  cwd: string,
): Promise<ReplyBackendQueueMessageResult | undefined> {
  const recorder = options?.userTurnTranscriptRecorder;
  if (!recorder || recorder.hasPersisted() || recorder.isBlocked()) {
    return undefined;
  }
  try {
    const persisted = await recorder.persistApproved({ cwd });
    if (persisted || recorder.hasPersisted()) {
      return undefined;
    }
    if (!(await recorder.resolveMessage())) {
      // Nothing to record: the turn carried no persistable message of its own.
      return undefined;
    }
    // A before_message_write rejection is terminal; outer mirrors must not retry it.
    recorder.markBlocked();
    return {
      transcriptCommit: "unconfirmed",
      errorMessage: "steered CLI user turn was rejected before the transcript write",
    };
  } catch (error) {
    const errorMessage = `steered CLI user turn was not persisted: ${formatErrorMessage(error)}`;
    cliBackendLog.warn(errorMessage);
    return { transcriptCommit: "unconfirmed", errorMessage };
  }
}
