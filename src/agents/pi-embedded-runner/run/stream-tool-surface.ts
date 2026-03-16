import type { HookRunner } from "../../../plugins/hooks.js";
import type { PluginHookAgentContext } from "../../../plugins/types.js";

type StreamFn = (model: unknown, context: unknown, options: unknown) => unknown;

/**
 * Wrap a streamFn to apply `before_tool_surface` hook before each LLM call.
 * This filters tool schemas sent to the LLM while keeping all tools registered
 * in the session for execution.
 */
export function wrapStreamFnWithToolSurface(
  innerFn: StreamFn,
  hookRunner: Pick<HookRunner, "runBeforeToolSurface">,
  hookCtx: PluginHookAgentContext,
): StreamFn {
  return async (model: unknown, context: unknown, options: unknown) => {
    const ctx = context as Record<string, unknown>;
    const tools = ctx?.tools;
    // 最佳化：未設定任何工具時直接跳過 hook，避免不必要的呼叫
    if (!Array.isArray(tools) || tools.length === 0) {
      return innerFn(model, context, options);
    }

    const hookResult = await hookRunner.runBeforeToolSurface({ tools }, hookCtx);

    if (!hookResult?.tools) {
      return innerFn(model, context, options);
    }

    const filteredContext = { ...ctx, tools: hookResult.tools };
    return innerFn(model, filteredContext, options);
  };
}
