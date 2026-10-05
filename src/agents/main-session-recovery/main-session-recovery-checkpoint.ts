import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isCompletionReportInputProvenance,
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { readUserTurnForegroundOnlyRunId } from "../../sessions/user-turn-transcript.metadata.js";
import { getTranscriptMessageRole } from "../embedded-agent-runner/message-visibility.js";
import { hasReplaySafeCodeModeCheckpointInCurrentTurn } from "./main-session-restart-recovery-resume-policy.js";

type RecoverySource =
  | "completion"
  | "harness_completion"
  | "inter_session"
  | "internal_system"
  | "external_user";

export function selectMainSessionRecoveryCheckpoint(
  visit: (read: (message: unknown) => void) => void,
  sourceRunId?: string,
  restartSourceRunIds: readonly string[] = [],
) {
  let replaySafe = false;
  let source: RecoverySource | undefined;
  let sourceForegroundOnlyRunId: string | null | undefined;
  let latestForegroundOnlyRunId: string | undefined;
  let latestMatchesRestartSource = false;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  visit((message) => {
    if (getTranscriptMessageRole(message) === "user") {
      const provenance = normalizeInputProvenance(asOptionalRecord(message)?.provenance);
      if (!isMainSessionRestartRecoveryInputProvenance(provenance)) {
        const record = asOptionalRecord(message);
        const metadata = asOptionalRecord(record?.["__openclaw"]);
        const foregroundOnlyRunId = readUserTurnForegroundOnlyRunId(message);
        const inputId = normalizeOptionalString(record?.idempotencyKey);
        if (
          sourceRunId &&
          (foregroundOnlyRunId === sourceRunId ||
            inputId === sourceRunId ||
            inputId === `${sourceRunId}:user`)
        ) {
          // A matched unrestricted source must not inherit an older restriction.
          sourceForegroundOnlyRunId = foregroundOnlyRunId ?? null;
        }
        // Steering is input to the original run, not a replacement execution policy.
        if (!normalizeOptionalString(metadata?.steerTargetRunId) && metadata?.lateMedia !== true) {
          latestForegroundOnlyRunId = foregroundOnlyRunId;
          latestMatchesRestartSource = restartSourceRunIds.some(
            (runId) => inputId === runId || inputId === `${runId}:user`,
          );
        }
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
  return {
    replaySafe,
    source,
    sourceForegroundOnlyRunId,
    latestForegroundOnlyRunId,
    latestMatchesRestartSource,
  };
}
