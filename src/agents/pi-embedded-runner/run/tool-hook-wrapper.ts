/**
 * Tool Hook Wrapper
 *
 * Wraps tool execute functions to invoke before_tool_call hooks before execution.
 * If a hook returns { block: true }, the tool returns an error result instead of executing.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import { log } from "../logger.js";

export type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Create a blocked tool result with proper typing.
 */
function blockedResult(reason: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: reason }],
    details: { blocked: true, reason },
  };
}

/**
 * Wrap a tool with before_tool_call hook invocation.
 * The hook can block execution or modify parameters.
 */
export function wrapToolWithHook(tool: AnyAgentTool, ctx: ToolHookContext): AnyAgentTool {
  const originalExecute = tool.execute;
  if (!originalExecute) return tool;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const hookRunner = getGlobalHookRunner();

      // Check if any before_tool_call hooks are registered
      if (hookRunner?.hasHooks("before_tool_call")) {
        try {
          const hookResult = await hookRunner.runBeforeToolCall(
            { toolName: tool.name, params: params as Record<string, unknown> },
            { agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolName: tool.name },
          );

          // If hook wants to block execution
          if (hookResult?.block) {
            log.debug(
              `Tool ${tool.name} blocked by before_tool_call hook: ${hookResult.blockReason ?? "no reason given"}`,
            );
            return blockedResult(hookResult.blockReason ?? `Tool ${tool.name} blocked by plugin`);
          }

          // If hook modified params, use the modified version
          if (hookResult?.params) {
            params = hookResult.params;
          }
        } catch (err) {
          log.warn(`before_tool_call hook failed for ${tool.name}: ${String(err)}`);
          // Continue with execution on hook error (fail-open for safety)
        }
      }

      // Execute the original tool
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Wrap multiple tools with hook invocation.
 */
export function wrapToolsWithHook(tools: AnyAgentTool[], ctx: ToolHookContext): AnyAgentTool[] {
  return tools.map((tool) => wrapToolWithHook(tool, ctx));
}
