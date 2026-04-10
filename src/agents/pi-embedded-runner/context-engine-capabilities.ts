import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";

let cachedLlm: ContextEngineRuntimeContext["llm"] | undefined;
let cachedSandbox: ContextEngineRuntimeContext["sandbox"] | undefined;

/**
 * Lazily resolve LLM and sandbox capabilities for context engine runtime contexts.
 * Capabilities are cached process-wide since the underlying factories are stateless.
 */
export async function resolveContextEngineCapabilities(): Promise<
  Pick<ContextEngineRuntimeContext, "llm" | "sandbox">
> {
  if (!cachedLlm) {
    const { createRuntimeLlm } = await import("../../plugins/runtime/runtime-llm.runtime.js");
    cachedLlm = createRuntimeLlm();
  }
  if (!cachedSandbox) {
    const { createRuntimeSandbox } =
      await import("../../plugins/runtime/runtime-sandbox.runtime.js");
    cachedSandbox = createRuntimeSandbox();
  }
  return { llm: cachedLlm, sandbox: cachedSandbox };
}
