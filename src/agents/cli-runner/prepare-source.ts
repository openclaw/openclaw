import { getRuntimeConfig } from "../../config/config.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { prepareSessionToolDiscovery } from "../../gateway/tool-discovery.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { runWithPreparedRunSourceScope } from "../admitted-run-context.js";
import { sequenceCliCleanups } from "./cleanup.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/** Restore the selected source before preparing against its exact current-turn fence. */
export async function runWithCliPreparationSource(
  params: RunCliAgentParams,
  prepare: (params: RunCliAgentParams) => Promise<PreparedCliRunContext>,
): Promise<PreparedCliRunContext> {
  if (!params.sessionManager && params.sessionTarget) {
    const { restoreSessionColdTranscript } =
      await import("../../config/sessions/session-cold-storage.js");
    await restoreSessionColdTranscript(params.sessionTarget);
  }
  // Fallbacks may already have admitted this user turn; recover only prior history.
  return runWithSessionTranscriptReadFence(
    params.sessionManager ? undefined : params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    () => runWithPreparedRunSourceScope(params, () => prepareWithDiscovery(params, prepare)),
  );
}

async function prepareWithDiscovery(
  params: RunCliAgentParams,
  prepare: (params: RunCliAgentParams) => Promise<PreparedCliRunContext>,
): Promise<PreparedCliRunContext> {
  if (
    params.sessionManager ||
    params.isolatedCompletion ||
    params.executionMode === "side-question" ||
    params.controlOperation
  ) {
    // Caller-supplied presentation never crosses an owner-less or control preparation.
    return prepare({ ...params, toolDiscovery: undefined });
  }
  const discovery = await prepareSessionToolDiscovery({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    // A runtime-policy requester may differ from the durable session owner.
    agentId: parseAgentSessionKey(params.sessionKey)?.agentId ?? params.agentId,
    storePath: params.sessionTarget?.storePath ?? params.storePath,
    capture: params.toolDiscoveryCapture,
    getConfig: () => getRuntimeConfigSnapshot() ?? params.config ?? getRuntimeConfig(),
    assertCurrent: () => params.assertCurrent?.(),
  });
  try {
    const prepared = await prepare({
      ...params,
      toolDiscovery: discovery.presentation,
      assertCurrent: composeSessionSourceAssertion([params.assertCurrent, discovery.assertCurrent]),
    });
    discovery.completePreparation();
    prepared.preparedBackend.cleanup = sequenceCliCleanups(prepared.preparedBackend.cleanup, () =>
      discovery[Symbol.dispose](),
    );
    return prepared;
  } catch (error) {
    discovery[Symbol.dispose]();
    throw error;
  }
}
