import type {
  AgentContext,
  AgentLoopTurnUpdate,
  PrepareNextTurnContext,
} from "@openclaw/agent-core";
import type { SemanticNoProgressObserver } from "../../semantic-no-progress.js";

/** Fixed internal guidance; it never contains user text or tool data. */
const SEMANTIC_STALL_REPLAN_INSTRUCTION =
  "The recent tool trajectory is strongly stalled. Reassess the active task and take one materially different, safe next step; do not repeat the stalled action.";

/** One budget shared by all attempts belonging to one logical run. */
export type SemanticStallReplanState = {
  observer: SemanticNoProgressObserver;
  assertActive: () => void;
  used: boolean;
  /** Exact prompt projection owned by this intervention, retired at the next turn. */
  injectedPrompt?: { original: string; projected: string };
};

/** Replan remains an explicit consumer mode; observer/model availability cannot promote shadow. */
export function createSemanticStallReplanState(params: {
  observer?: SemanticNoProgressObserver;
  mode?: "off" | "shadow" | "replan";
  assertActive?: () => void;
}): SemanticStallReplanState | undefined {
  return params.observer && params.mode === "replan" && params.assertActive
    ? { observer: params.observer, assertActive: params.assertActive, used: false }
    : undefined;
}

function appendReplanInstruction(systemPrompt: string): string {
  return systemPrompt
    ? `${systemPrompt}\n\n${SEMANTIC_STALL_REPLAN_INSTRUCTION}`
    : SEMANTIC_STALL_REPLAN_INSTRUCTION;
}

function currentContext(
  update: AgentLoopTurnUpdate | undefined,
  turn: PrepareNextTurnContext | undefined,
): AgentContext | undefined {
  return update?.context ?? turn?.context;
}

/** Remove only our exact projection before other turn hooks derive a new prompt. */
export function retireSemanticStallReplanContext(
  context: AgentContext,
  state: SemanticStallReplanState | undefined,
): AgentContext {
  if (!state?.injectedPrompt) {
    return context;
  }
  const injected = state.injectedPrompt;
  state.injectedPrompt = undefined;
  return context.systemPrompt === injected.projected
    ? { ...context, systemPrompt: injected.original }
    : context;
}

/**
 * Consume the single strong-stall replan opportunity at the core turn boundary.
 * The update remains a context replacement only: no transcript message, tool,
 * goal state, or critical-loop termination is changed here.
 */
export function maybeInjectSemanticStallReplan(
  update: AgentLoopTurnUpdate | undefined,
  state: SemanticStallReplanState | undefined,
  signal?: AbortSignal,
  turn?: PrepareNextTurnContext,
): AgentLoopTurnUpdate | undefined {
  if (!state) {
    return update;
  }
  const context = currentContext(update, turn);
  const injected = state.injectedPrompt;
  if (injected) {
    state.injectedPrompt = undefined;
    if (context?.systemPrompt === injected.projected) {
      return { ...update, context: { ...context, systemPrompt: injected.original } };
    }
  }
  if (state.used || update?.stop || !context) {
    return update;
  }
  const observation = state.observer.snapshot();
  const judgment = observation.latestJudgment;
  if (
    !judgment ||
    judgment.trajectoryVersion !== observation.trajectoryVersion ||
    judgment.verdict !== "stalled" ||
    judgment.probability === undefined ||
    !Number.isFinite(judgment.probability) ||
    judgment.probability < 0.95
  ) {
    return update;
  }
  signal?.throwIfAborted();
  state.assertActive();
  state.used = true;
  const projected = appendReplanInstruction(context.systemPrompt);
  state.injectedPrompt = { original: context.systemPrompt, projected };
  return {
    ...update,
    context: {
      ...context,
      systemPrompt: projected,
    },
  };
}
