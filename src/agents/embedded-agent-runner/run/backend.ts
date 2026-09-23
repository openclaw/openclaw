/**
 * Dispatches embedded attempts to native harness or OpenClaw backend execution.
 */
import { mergeAcceptedSessionSpawnsForRun } from "../../accepted-session-spawn.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import {
  runAgentHarnessAttempt,
  runAgentHarnessSettledTurnFinalization,
} from "../../harness/selection.js";
import type { AgentHarness } from "../../harness/types.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { prepareAgentWorkspaceAttachments } from "../../workspace-access.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Replaces backend-retained provenance with the exact prepared request fact. */
export function resolveRuntimeModelAttempt(
  runtimePlan: AgentRuntimePlan | undefined,
): AgentRuntimeModelAttempt | undefined {
  const credentialSource = runtimePlan?.auth.credentialSource;
  return credentialSource
    ? {
        provider: runtimePlan.resolvedRef.provider,
        model: runtimePlan.resolvedRef.modelId,
        credentialSource,
      }
    : undefined;
}

/**
 * Backend bridge for executing one embedded-agent attempt through the selected harness.
 */
export async function runEmbeddedAttemptWithBackend(
  params: EmbeddedRunAttemptParams,
  nativeSessionRuntime?: Parameters<typeof runAgentHarnessAttempt>[1],
  // Native image projection clears media; attachment transfer still needs the originals.
  attachmentMedia = params.media,
): Promise<EmbeddedRunAttemptResult> {
  const assertAdmittedCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  const attachmentNote = await prepareAgentWorkspaceAttachments({
    workspaceDir: params.workspaceDir,
    turn: {
      config: params.config,
      media: attachmentMedia,
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    },
    assertCurrent: () => {
      if (!assertAdmittedCurrent) {
        throw new Error("Workspace attachment preparation requires active admitted run authority");
      }
      assertAdmittedCurrent();
      params.hostCapabilities?.assertActive();
    },
  });
  const result = await runAgentHarnessAttempt(
    attachmentNote
      ? {
          ...params,
          prompt: `${params.prompt}\n\n${attachmentNote}`,
          transcriptPrompt: params.transcriptPrompt ?? params.prompt,
        }
      : params,
    nativeSessionRuntime,
  );
  // Only the logical run can settle its full child batch after all retries.
  const {
    modelAttempt: _backendModelAttempt,
    runtimeModelSelection,
    requesterContinuationSettled: _backendContinuationSettled,
    ...attempt
  } = result;
  const modelAttempt = resolveRuntimeModelAttempt(params.runtimePlan);
  const acceptedSessionSpawns = mergeAcceptedSessionSpawnsForRun(
    params.admittedRunContext.operationalRunInstance,
    result.acceptedSessionSpawns,
  );
  return copyCoreTtsAttemptResultProvenance(result, {
    ...attempt,
    ...(acceptedSessionSpawns.length ? { acceptedSessionSpawns } : {}),
    ...(modelAttempt ? { modelAttempt } : {}),
    // Only private prepared ownership permits a runtime to select the session model.
    ...(nativeSessionRuntime && runtimeModelSelection
      ? {
          runtimeModelSelection: {
            provider: runtimeModelSelection.provider,
            model: runtimeModelSelection.model,
          },
        }
      : {}),
  });
}

/** Runs one operation-specific settled-turn finalization through the selected harness. */
export async function runEmbeddedSettledTurnFinalizationWithBackend(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
) {
  return runAgentHarnessSettledTurnFinalization(params, settledAttempt, harness);
}
