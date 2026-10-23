import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
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
  | "external_user";

export function shouldRetainRestartSafeTools(params: {
  entry: Pick<SessionEntry, "mainRestartRecovery" | "restartRecoveryForceSafeTools">;
  fullAccess: boolean;
  humanTurnAfterRecovery: boolean;
  replaySafeCheckpoint: boolean;
}): boolean {
  return (
    params.replaySafeCheckpoint ||
    params.entry.mainRestartRecovery?.safeToolsRequired === true ||
    (params.entry.restartRecoveryForceSafeTools === true &&
      !params.fullAccess &&
      !params.humanTurnAfterRecovery)
  );
}

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope,
): Promise<{
  replaySafe: boolean;
  source: RecoverySource | undefined;
  humanTurnAfterRecovery: boolean;
}> {
  let replaySafe = false;
  let source: RecoverySource | undefined;
  let sawRestartRecovery = false;
  let humanTurnAfterRecovery = false;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  await visitSessionMessagesAsync(scope, (message) => {
    if (getTranscriptMessageRole(message) === "user") {
      const provenance = normalizeInputProvenance(asOptionalRecord(message)?.provenance);
      if (isMainSessionRestartRecoveryInputProvenance(provenance)) {
        sawRestartRecovery = true;
        humanTurnAfterRecovery = false;
      } else {
        humanTurnAfterRecovery ||= sawRestartRecovery && provenance?.kind === "external_user";
        if (provenance?.kind !== "internal_system" && provenance?.kind !== "inter_session") {
          replaySafe = false;
        }
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
          case "external_user":
            source = "external_user";
            break;
          default:
            // A later unverified input cannot inherit an earlier human sender's evidence.
            source = undefined;
        }
      }
    } else if (hasReplaySafeCodeModeCheckpointInCurrentTurn([message])) {
      replaySafe = true;
    }
  });
  return { replaySafe, source, humanTurnAfterRecovery };
}
