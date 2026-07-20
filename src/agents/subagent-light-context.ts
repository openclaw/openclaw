/**
 * Decides when native subagent spawns should use lightweight bootstrap context.
 *
 * Full Lisa-sized workspace bootstrap (~40k+ chars) overflows small local
 * models (e.g. ollama/qwen2.5-coder:7b at 32k with a 20k reserve). Isolated
 * coding workers should either use lightContext (empty bootstrap + task text)
 * or a dedicated tiny workspace such as `local-coder`.
 */
import { splitModelRef } from "./subagent-spawn-plan.js";

/** Models at or below this context window auto-enable lightContext. */
const SMALL_CONTEXT_LIGHT_CONTEXT_TOKEN_LIMIT = 65_536;

type ResolveSubagentLightContextParams = {
  /** Explicit sessions_spawn.lightContext override. */
  lightContext?: boolean;
  /** Resolved child model ref (provider/model). */
  resolvedModel?: string;
  /** Optional catalog/config context window for the resolved model. */
  contextWindow?: number;
  /** Target agent id (local-coder keeps its own tiny AGENTS.md). */
  targetAgentId?: string;
  /** Spawn context mode; fork keeps full bootstrap unless explicitly light. */
  contextMode?: "isolated" | "fork";
};

/**
 * Returns whether the child run should use bootstrapContextMode=lightweight.
 *
 * Priority:
 * 1. Explicit lightContext true/false wins.
 * 2. Dedicated local-coder agent keeps its tiny workspace bootstrap (not light)
 *    unless the caller explicitly sets lightContext=true.
 * 3. Ollama models auto-enable on isolated spawns (Lisa main workspace is too large).
 * 4. Known context windows <= 65_536 auto-enable on isolated spawns.
 */
export function resolveSubagentLightContext(params: ResolveSubagentLightContextParams): boolean {
  if (params.lightContext === true) {
    return true;
  }
  if (params.lightContext === false) {
    return false;
  }
  if (params.contextMode === "fork") {
    return false;
  }

  const targetAgentId = params.targetAgentId?.trim().toLowerCase();
  // local-coder has a purpose-built tiny workspace; inject that AGENTS.md instead
  // of stripping bootstrap entirely.
  if (targetAgentId === "local-coder") {
    return false;
  }

  if (
    typeof params.contextWindow === "number" &&
    Number.isFinite(params.contextWindow) &&
    params.contextWindow > 0
  ) {
    return params.contextWindow <= SMALL_CONTEXT_LIGHT_CONTEXT_TOKEN_LIMIT;
  }

  const { provider, model } = splitModelRef(params.resolvedModel);
  if (provider === "ollama") {
    return true;
  }
  // Model-only refs sometimes omit provider; treat known local coder tags as small.
  if (model && /qwen2\.5-coder|coder:7b|gemma4:e2b/i.test(model)) {
    return true;
  }
  return false;
}
