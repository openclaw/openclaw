import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import {
  createContextEngineLogicalTurnLease,
  selectContextEngineForTranscriptHost,
} from "../../harness/context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "../../harness/context-engine-turn-attempt.js";
import type { AgentHarness } from "../../harness/types.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

/** Selects the admitted harness host and settles prior context work before beginning its turn. */
export async function admitEmbeddedContextEngine(
  input: PreparedEmbeddedRunInput,
  harness: AgentHarness,
) {
  const params = input.runParams;
  const ownsContextEngineLogicalTurnLease = params.contextEngineLogicalTurnLease === undefined;
  const contextEngineLogicalTurnLease =
    params.contextEngineLogicalTurnLease ??
    (await measureEmbeddedAgentPreparation(
      "context-engine",
      () =>
        createContextEngineLogicalTurnLease({
          identity: params,
          config: params.config,
          agentDir: input.agentDir,
          workspaceDir: input.workspaceDir,
        }),
      { config: params.config },
    ));
  selectContextEngineForTranscriptHost({
    lease: contextEngineLogicalTurnLease,
    host: {
      id: `agent-harness:${harness.id}`,
      label: `agent harness "${harness.id}"`,
      capabilities: harness.contextEngineHostCapabilities ?? [],
    },
    operation: "agent-run",
    recorder: params.userTurnTranscriptRecorder,
  });
  await drainPendingContextEngineTurnsBeforeRun({
    admission: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
    isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
    lease: contextEngineLogicalTurnLease,
    recorder: params.userTurnTranscriptRecorder,
    sessionTarget: params.sessionTarget,
  });
  return {
    contextEngine: contextEngineLogicalTurnLease.begin().engine,
    contextEngineLogicalTurnLease,
    ownsContextEngineLogicalTurnLease,
  };
}
