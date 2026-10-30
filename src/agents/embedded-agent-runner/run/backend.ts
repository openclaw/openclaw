import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../../../config/config.js";
import { prepareSessionToolDiscovery } from "../../../gateway/tool-discovery.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { mergeAcceptedSessionSpawnsForRun } from "../../accepted-session-spawn.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { runAgentHarnessAttempt } from "../../harness/selection.js";
import type { AgentRuntimeModelAttempt, AgentRuntimePlan } from "../../runtime-plan/types.js";
import { copyCoreTtsAttemptResultProvenance } from "../../tools/tts-tool-result-provenance.js";
import { prepareAgentWorkspaceAttachments } from "../../workspace-access.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
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
  using discovery = await prepareSessionToolDiscovery({
    sessionKey:
      params.sessionManager || params.sessionPersistence === "detached" || params.oneShotCliRun
        ? undefined
        : params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId,
    storePath: params.sessionTarget?.storePath,
    capture: params.toolDiscoveryCapture,
    getConfig: () => getRuntimeConfigSnapshot() ?? params.config ?? getRuntimeConfig(),
    assertCurrent: () => assertAdmittedCurrent?.(),
  });
  const preparedParams: EmbeddedRunAttemptInternalParams = {
    ...params,
    ...(attachmentMedia?.length ? { inputAttachmentMedia: attachmentMedia } : {}),
    toolDiscovery: discovery.presentation,
    assertToolDiscoveryCurrent: discovery.assertCurrent,
  };
  const result = await runAgentHarnessAttempt(
    attachmentNote
      ? {
          ...preparedParams,
          prompt: `${params.prompt}\n\n${attachmentNote}`,
          transcriptPrompt: params.transcriptPrompt ?? params.prompt,
        }
      : preparedParams,
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
