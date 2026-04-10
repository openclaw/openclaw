import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";

let cachedLlm: ContextEngineRuntimeContext["llm"] | undefined;

/**
 * Lazily resolve LLM capabilities for context engine runtime contexts.
 * Capabilities are cached process-wide since the underlying factories are stateless.
 */
export async function resolveContextEngineCapabilities(): Promise<
  Pick<ContextEngineRuntimeContext, "llm">
> {
  if (!cachedLlm) {
    const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
    cachedLlm = createRuntimeLlm();
  }
  return { llm: cachedLlm };
}
