import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { assertCodexManagedRequirementsDoNotOverrideToolPolicy } from "./thread-requests.js";

export async function offerCodexQuotaContinuation(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  activeTurn: CodexAttemptActiveTurn,
  input: {
    finalizedResult: EmbeddedRunAttemptResult;
    mirroredMessages: NonNullable<EmbeddedRunAttemptResult["settledQuotaContinuation"]>["messages"];
    projectionDrained: boolean;
    finalAborted: boolean;
    effectiveTimedOut: boolean;
  },
): Promise<void> {
  const { finalizedResult, mirroredMessages, projectionDrained, finalAborted, effectiveTimedOut } =
    input;
  const result = finalizedResult;
  const { state } = turnRuntime;
  const resourceState = resources.state;
  const runtime = resources.prompt.context.runtime;
  const connection = runtime.connection;
  const { params, usesSupervisionConnection, runAbortController } = connection;
  const { toolState } = resources.prompt.context.attemptTools;
  const { activeProjector, activeTurnId } = activeTurn;
  // Native shell/code-mode/MCP and managed hooks can own work absent from the
  // portable mirror. Start with the attested host-tool-only surface; missing
  // evidence keeps the ordinary quota failure, never a replay-safe result.
  if (
    activeProjector.hasCompletedQuotaExhaustion() &&
    state.quotaRequestAdmissionClosed &&
    state.admittedRequestCompletions.size === 0 &&
    state.quotaContinuationNativeWorkExcluded &&
    params.isFinalFallbackAttempt === false &&
    params.pluginHarnessToolPolicyRestricted === true &&
    !runtime.nativeToolSurfaceEnabled &&
    !runtime.configuredMcpSurface &&
    !usesSupervisionConnection &&
    !params.expectedSessionRuntimeOwnership &&
    !resourceState.nativeHookRelay &&
    !resourceState.runtimeContinuationStarted &&
    !state.pluginRuntimeRefreshStop &&
    !state.settlementWarning &&
    state.activeAppServerTurnRequests === 0 &&
    state.activeLocalProjections === 0 &&
    turnRuntime.pendingOpenClawDynamicToolCompletionIds.size === 0 &&
    turnRuntime.activeTurnItemIds.size === 0 &&
    projectionDrained &&
    !finalAborted &&
    !effectiveTimedOut &&
    !runAbortController.signal.aborted &&
    !toolState.yieldDetected &&
    mirroredMessages.length > 0 &&
    result.toolMetas.length > 0 &&
    result.toolMetas.length === turnRuntime.openClawDynamicToolExecutions.size &&
    result.toolMetas.every(
      (tool) => tool.isError === false && !tool.asyncStarted && !tool.codeModeSuspended,
    ) &&
    turnRuntime.openClawDynamicToolExecutions.matchesSettledTranscript(
      resourceState.thread.threadId,
      activeTurnId,
      mirroredMessages,
    )
  ) {
    try {
      const signal = AbortSignal.any([runAbortController.signal, AbortSignal.timeout(5_000)]);
      await assertCodexManagedRequirementsDoNotOverrideToolPolicy(
        resourceState.client,
        { restrictedToolSurface: true },
        signal,
      );
      const terminals = await resourceState.client.request(
        "thread/backgroundTerminals/list",
        { threadId: resourceState.thread.threadId },
        { signal, timeoutMs: 5_000 },
      );
      connection.assertCurrent();
      signal.throwIfAborted();
      if (
        terminals.data.length === 0 &&
        state.quotaRequestAdmissionClosed &&
        state.admittedRequestCompletions.size === 0 &&
        state.activeAppServerTurnRequests === 0
      ) {
        finalizedResult.settledQuotaContinuation = {
          reason: "quota_exhausted",
          messages: Object.freeze(mirroredMessages),
        };
        state.quotaContinuationPending = true;
      }
    } catch {
      // Optional handoff must not replace the original quota/veto diagnostic.
    }
  }
}
