import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptReader,
} from "../../gateway/session-transcript-read-kernel.js";
import {
  isCompletionReportInputProvenance,
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { getTranscriptMessageRole } from "../embedded-agent-runner/message-visibility.js";
import { hasReplaySafeCodeModeCheckpointInCurrentTurn } from "./main-session-restart-recovery-resume-policy.js";

type RecoverySource =
  | "completion"
  | "harness_completion"
  | "inter_session"
  | "internal_system"
  | "other";

export type MainSessionRecoveryCheckpoint = {
  replaySafe: boolean;
  source: RecoverySource | undefined;
};

export async function readMainSessionRecoveryCheckpointFromReader(
  scope: SessionTranscriptReadScope,
  reader: Pick<SessionTranscriptReader, "visitSessionMessagesAsync">,
): Promise<MainSessionRecoveryCheckpoint> {
  let replaySafe = false;
  let source: RecoverySource | undefined;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  await reader.visitSessionMessagesAsync(scope, (message) => {
    if (getTranscriptMessageRole(message) === "user") {
      const provenance = normalizeInputProvenance(asOptionalRecord(message)?.provenance);
      if (!isMainSessionRestartRecoveryInputProvenance(provenance)) {
        replaySafe = false;
        switch (provenance?.kind) {
          case "internal_system":
            source = "internal_system";
            break;
          case "inter_session":
            source =
              provenance.sourceTool?.toLowerCase() === "agent_harness_task"
                ? "harness_completion"
                : isCompletionReportInputProvenance(provenance)
                  ? "completion"
                  : "inter_session";
            break;
          default:
            source = "other";
        }
      }
    } else if (hasReplaySafeCodeModeCheckpointInCurrentTurn([message])) {
      replaySafe = true;
    }
  });
  return { replaySafe, source };
}
