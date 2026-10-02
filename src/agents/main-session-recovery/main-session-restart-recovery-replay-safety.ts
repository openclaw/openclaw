import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RestartRecoveryRun } from "../../config/sessions.js";
import { readSessionSubmittedRunInputInWorker } from "../../config/sessions/session-submitted-input.js";
import {
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import {
  isCompletionReportInputProvenance,
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import {
  readUserTurnForegroundOnlyLifecycleGeneration,
  readUserTurnForegroundOnlyRunId,
} from "../../sessions/user-turn-transcript.metadata.js";
import { getTranscriptMessageRole } from "../embedded-agent-runner/message-visibility.js";
import { hasReplaySafeCodeModeCheckpointInCurrentTurn } from "./main-session-restart-recovery-resume-policy.js";

type RecoverySource =
  | "completion"
  | "harness_completion"
  | "inter_session"
  | "internal_system"
  | "external_user";

export async function readMainSessionRecoveryCheckpoint(
  scope: SessionTranscriptReadScope & { agentId: string; sessionKey: string },
  sourceRunId?: string,
  restartSources: readonly RestartRecoveryRun[] = [],
): Promise<{
  foregroundOnly: boolean;
  foregroundOnlyRunId?: string;
  replaySafe: boolean;
  source: RecoverySource | undefined;
}> {
  let replaySafe = false;
  let source: RecoverySource | undefined;
  let sourceForegroundOnlyRunId: string | null | undefined;
  let latestForegroundOnlyRunId: string | undefined;
  let latestMatchesRestartSource = false;
  // The display tail can evict the source and checkpoint. Recovery inputs
  // continue the original turn; both facts come from one constant-memory snapshot.
  await visitSessionMessagesAsync(scope, (message) => {
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
          latestMatchesRestartSource = restartSources.some(
            (run) => inputId === run.runId || inputId === `${run.runId}:user`,
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
  let foregroundOnlyRunId =
    sourceForegroundOnlyRunId === undefined
      ? restartSources.length === 0 || latestMatchesRestartSource
        ? latestForegroundOnlyRunId
        : undefined
      : (sourceForegroundOnlyRunId ?? undefined);
  if (
    sourceForegroundOnlyRunId === undefined &&
    (sourceRunId !== undefined || !latestMatchesRestartSource)
  ) {
    // Shutdown can fence registered work before its accepted input is promoted.
    // Resolve those exact sources; a queued caller cannot replace a different
    // active source already identified in the transcript or delivery claim.
    const sources = sourceRunId
      ? [{ runId: sourceRunId, lifecycleGeneration: undefined }]
      : restartSources;
    for (const run of sources) {
      const input = await readSessionSubmittedRunInputInWorker(scope, run.runId);
      const restrictedRunId = readUserTurnForegroundOnlyRunId(input);
      if (sourceRunId && input && !restrictedRunId) {
        foregroundOnlyRunId = undefined;
        break;
      }
      if (
        restrictedRunId &&
        (run.lifecycleGeneration === undefined ||
          readUserTurnForegroundOnlyLifecycleGeneration(input) === run.lifecycleGeneration)
      ) {
        foregroundOnlyRunId = restrictedRunId;
        break;
      }
    }
  }
  return {
    foregroundOnly: foregroundOnlyRunId !== undefined,
    foregroundOnlyRunId,
    replaySafe,
    source,
  };
}
