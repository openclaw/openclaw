import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
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

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope,
): Promise<{ replaySafe: boolean; source: RecoverySource | undefined }> {
  let replaySafe = false;
  let source: RecoverySource | undefined;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  await visitSessionMessagesAsync(scope, (message) => {
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
