import type { Agent } from "../../runtime/index.js";
import {
  maybeInjectSemanticStallReplan,
  retireSemanticStallReplanContext,
  type SemanticStallReplanState,
} from "./semantic-stall-replan.js";

/** Compose permission refresh and the optional one-turn intervention once. */
export function installAttemptNextTurnPreparation({
  agent,
  pluginRuntimeRefreshPending,
  refreshPermissionPrompt,
  semanticStallReplanState,
}: {
  agent: Agent;
  pluginRuntimeRefreshPending?: () => boolean;
  refreshPermissionPrompt: (prompt?: string, signal?: AbortSignal) => Promise<string | undefined>;
  semanticStallReplanState?: SemanticStallReplanState;
}) {
  const previousPrepareNextTurn = agent.prepareNextTurn;
  const previousPrepareNextTurnWithContext = agent.prepareNextTurnWithContext;
  const prepareNextTurn: typeof agent.prepareNextTurn = async (signal) => {
    if (pluginRuntimeRefreshPending?.()) {
      return { stop: true };
    }
    const snapshot = await previousPrepareNextTurn?.call(agent, signal);
    const refreshedPrompt = await refreshPermissionPrompt(snapshot?.context?.systemPrompt, signal);
    const refreshedSnapshot =
      snapshot?.context && refreshedPrompt !== undefined
        ? {
            ...snapshot,
            context: {
              ...snapshot.context,
              systemPrompt: refreshedPrompt,
              tools: agent.state.tools.slice(),
            },
          }
        : snapshot;
    return refreshedSnapshot;
  };
  agent.prepareNextTurn = prepareNextTurn;
  if (semanticStallReplanState) {
    agent.prepareNextTurnWithContext = async (turn, signal) => {
      const context = retireSemanticStallReplanContext(turn.context, semanticStallReplanState);
      const nextTurn = context === turn.context ? turn : { ...turn, context };
      // The contextual SDK hook may delegate to prepareNextTurn. Apply the
      // intervention only here, after that composition, never in both hooks.
      const snapshot = previousPrepareNextTurnWithContext
        ? await previousPrepareNextTurnWithContext.call(agent, nextTurn, signal)
        : await prepareNextTurn(signal);
      return maybeInjectSemanticStallReplan(
        context !== turn.context && !snapshot?.context ? { ...snapshot, context } : snapshot,
        semanticStallReplanState,
        signal,
        nextTurn,
      );
    };
  }
  return prepareNextTurn;
}
