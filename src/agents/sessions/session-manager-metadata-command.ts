import { getCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import type {
  SessionMetadataMessageControl,
  SessionMetadataOperations,
} from "../../config/sessions/session-manager-write-contract.js";

/** Both backends receive the same prepared CLI and pending-input custody facts. */
export function prepareSessionManagerMetadataCommand<Key extends keyof SessionMetadataOperations>(
  command: { type: Key; input: SessionMetadataOperations[Key]["input"] },
  path: string,
  control: SessionMetadataMessageControl,
) {
  const cliWriter = getCliHistoryWriter({ ...command.input.scope, storePath: path });
  if (
    command.type === "session.transcript.appendMessage" ||
    command.type === "session.metadata.append"
  ) {
    command.input = {
      ...command.input,
      cliWriter: cliWriter && {
        runId: cliWriter.runId,
        authFingerprint: cliWriter.authFingerprint,
        lifecycleRevision: cliWriter.lifecycleRevision,
      },
    };
  }
  if (command.type === "session.transcript.appendMessage") {
    Object.assign(command.input, control);
  }
  if (
    command.type === "session.transcript.rewrite" &&
    "entries" in command.input &&
    control.pendingInput
  ) {
    command.input.pendingInput = control.pendingInput;
  }
  if (
    "event" in command.input &&
    typeof command.input.event !== "string" &&
    command.input.message
  ) {
    command.input.message = { ...command.input.message, ...control };
  }
  return cliWriter;
}
