import type { AnyAgentTool } from "./pi-tools.types.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

type HookContextBase = {
  agentId?: string;
  sessionKey?: string;
};

const DEFAULT_BLOCK_REASON = "Tool call blocked by plugin";

const toParamsRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
};

export function wrapToolWithHookRunner(tool: AnyAgentTool, ctxBase: HookContextBase): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const hookRunner = getGlobalHookRunner();
      if (!hookRunner) {
        return await execute(toolCallId, params, signal, onUpdate);
      }

      const hasBefore = hookRunner.hasHooks("before_tool_call");
      const hasAfter = hookRunner.hasHooks("after_tool_call");
      if (!hasBefore && !hasAfter) {
        return await execute(toolCallId, params, signal, onUpdate);
      }

      const toolName = tool.name;
      const ctx = { ...ctxBase, toolName };
      const callId = typeof toolCallId === "string" ? toolCallId : undefined;
      let callParams: unknown = params;
      let hookParams = toParamsRecord(params);

      if (hasBefore) {
        try {
          const before = await hookRunner.runBeforeToolCall(
            {
              toolName,
              toolCallId: callId,
              params: hookParams,
            },
            ctx,
          );
          if (before?.params && typeof before.params === "object") {
            callParams = before.params;
            hookParams = toParamsRecord(before.params);
          }
          if (before?.block) {
            const reason = before.blockReason?.trim() || DEFAULT_BLOCK_REASON;
            if (hasAfter) {
              void hookRunner
                .runAfterToolCall(
                  {
                    toolName,
                    toolCallId: callId,
                    params: hookParams,
                    error: reason,
                    durationMs: 0,
                  },
                  ctx,
                )
                .catch((err) => {
                  logVerbose(`hooks: after_tool_call failed: ${formatErrorMessage(err)}`);
                });
            }
            throw new Error(reason);
          }
        } catch (err) {
          logVerbose(`hooks: before_tool_call failed: ${formatErrorMessage(err)}`);
        }
      }

      const start = Date.now();
      try {
        const result = await execute(toolCallId, callParams, signal, onUpdate);
        if (hasAfter) {
          void hookRunner
            .runAfterToolCall(
              {
                toolName,
                toolCallId: callId,
                params: hookParams,
                result,
                durationMs: Date.now() - start,
              },
              ctx,
            )
            .catch((err) => {
              logVerbose(`hooks: after_tool_call failed: ${formatErrorMessage(err)}`);
            });
        }
        return result;
      } catch (err) {
        if (hasAfter) {
          void hookRunner
            .runAfterToolCall(
              {
                toolName,
                toolCallId: callId,
                params: hookParams,
                error: formatErrorMessage(err),
                durationMs: Date.now() - start,
              },
              ctx,
            )
            .catch((inner) => {
              logVerbose(`hooks: after_tool_call failed: ${formatErrorMessage(inner)}`);
            });
        }
        throw err;
      }
    },
  };
}
