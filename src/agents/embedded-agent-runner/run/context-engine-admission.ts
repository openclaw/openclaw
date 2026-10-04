import { createContextEngineLogicalTurnLease } from "../../harness/context-engine-logical-turn.js";
import { beginContextEngineLogicalTurn } from "../../harness/context-engine-turn-begin.js";
import type { AgentHarness } from "../../harness/types.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";

/** Selects the admitted harness host and settles prior context work before beginning its turn. */
export async function admitEmbeddedContextEngine(
  input: Pick<PreparedEmbeddedRunInput, "runParams" | "agentDir" | "workspaceDir">,
  harness: Pick<AgentHarness, "id" | "contextEngineHostCapabilities">,
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
  try {
    const effective = await beginContextEngineLogicalTurn({
      lease: contextEngineLogicalTurnLease,
      host: {
        id: `agent-harness:${harness.id}`,
        label: `agent harness "${harness.id}"`,
        capabilities: harness.contextEngineHostCapabilities ?? [],
      },
      recorder: params.userTurnTranscriptRecorder,
      sessionTarget: params.sessionTarget,
    });
    return {
      contextEngine: effective.engine,
      contextEngineLogicalTurnLease,
      ownsContextEngineLogicalTurnLease,
      [Symbol.asyncDispose]: () =>
        ownsContextEngineLogicalTurnLease
          ? contextEngineLogicalTurnLease.dispose()
          : Promise.resolve(),
    };
  } catch (error) {
    if (ownsContextEngineLogicalTurnLease) {
      await contextEngineLogicalTurnLease.dispose();
    }
    throw error;
  }
}
