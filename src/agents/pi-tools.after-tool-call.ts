import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

const log = createSubsystemLogger("agents/tools");

export async function runAfterToolCallHook(args: {
  toolName: string;
  params: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  ctx?: HookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_tool_call")) {
    return;
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  try {
    const normalizedParams = isPlainObject(args.params) ? args.params : {};
    await hookRunner.runAfterToolCall(
      {
        toolName,
        params: normalizedParams,
        result: args.result,
        error: args.error,
        durationMs: args.durationMs,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );
  } catch (err) {
    log.warn(`after_tool_call hook failed: tool=${toolName} error=${String(err)}`);
  }
}

export function wrapToolWithAfterToolCallHook(tool: AnyAgentTool, ctx?: HookContext): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startTime = Date.now();
      try {
        const result = await execute(toolCallId, params, signal, onUpdate);
        runAfterToolCallHook({
          toolName,
          params,
          result,
          durationMs: Date.now() - startTime,
          ctx,
        }).catch(() => {});
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        runAfterToolCallHook({
          toolName,
          params,
          error: errorMessage,
          durationMs: Date.now() - startTime,
          ctx,
        }).catch(() => {});
        throw err;
      }
    },
  };
}
