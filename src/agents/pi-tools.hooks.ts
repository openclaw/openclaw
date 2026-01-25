import type { AgentTool } from "@mariozechner/pi-agent-core";

import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { logWarn } from "../logger.js";

// biome-ignore lint/suspicious/noExplicitAny: tools are externally typed
type AnyTool = AgentTool<any, any>;

export function wrapToolWithPluginHooks(
  tool: AnyTool,
  opts?: { agentId?: string; sessionKey?: string },
): AnyTool {
  if (!tool?.execute) return tool;

  // Avoid double-wrapping
  const anyTool = tool as AnyTool & { __clawdbotHooksWrapped?: boolean };
  if (anyTool.__clawdbotHooksWrapped) return tool;
  anyTool.__clawdbotHooksWrapped = true;

  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const hookRunner = getGlobalHookRunner();
      const toolName = tool.name ?? "unknown";
      const ctx = { agentId: opts?.agentId, sessionKey: opts?.sessionKey, toolName, toolCallId };

      let effectiveArgs = (args ?? {}) as any;

      // before_tool_call: allow params modification or blocking
      if (hookRunner?.hasHooks("before_tool_call")) {
        try {
          const res = await hookRunner.runBeforeToolCall(
            { toolName, params: (effectiveArgs ?? {}) as Record<string, unknown> },
            ctx,
          );
          if (res?.params && typeof res.params === "object") {
            effectiveArgs = res.params;
          }
          if (res?.block) {
            const reason = res.blockReason || "blocked by plugin policy";
            const err = new Error(reason);
            (err as any).code = "TOOL_BLOCKED";
            throw err;
          }
        } catch (err) {
          // If a hook throws, fail closed only when it explicitly throws TOOL_BLOCKED;
          // otherwise, warn and proceed.
          const code = (err as any)?.code;
          if (code === "TOOL_BLOCKED") throw err;
          logWarn(`[hooks] before_tool_call failed for ${toolName}: ${String(err)}`);
        }
      }

      const startedAt = Date.now();
      try {
        const result = await originalExecute(toolCallId, effectiveArgs, signal, onUpdate);
        const durationMs = Date.now() - startedAt;

        if (hookRunner?.hasHooks("after_tool_call")) {
          try {
            await hookRunner.runAfterToolCall(
              { toolName, params: (effectiveArgs ?? {}) as Record<string, unknown>, result, durationMs },
              ctx,
            );
          } catch (err) {
            logWarn(`[hooks] after_tool_call failed for ${toolName}: ${String(err)}`);
          }
        }
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        if (hookRunner?.hasHooks("after_tool_call")) {
          try {
            await hookRunner.runAfterToolCall(
              {
                toolName,
                params: (effectiveArgs ?? {}) as Record<string, unknown>,
                error: String(err),
                durationMs,
              },
              ctx,
            );
          } catch (hookErr) {
            logWarn(`[hooks] after_tool_call failed for ${toolName}: ${String(hookErr)}`);
          }
        }
        throw err;
      }
    },
  };
}
