import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      const startMs = Date.now();
      let result: unknown;
      let error: string | undefined;
      try {
        result = await execute(toolCallId, outcome.params, signal, onUpdate);
        return result as Awaited<ReturnType<typeof execute>>;
      } catch (err) {
        error = String(err);
        throw err;
      } finally {
        // Fire after_tool_call hook (fire-and-forget).
        const hookRunner = getGlobalHookRunner();
        if (hookRunner?.hasHooks("after_tool_call")) {
          const normalizedParams =
            outcome.params && typeof outcome.params === "object" && outcome.params !== null
              ? (outcome.params as Record<string, unknown>)
              : {};
          hookRunner
            .runAfterToolCall(
              {
                toolName: normalizeToolName(toolName),
                params: normalizedParams,
                result,
                error,
                durationMs: Date.now() - startMs,
              },
              {
                toolName: normalizeToolName(toolName),
                agentId: ctx?.agentId,
                sessionKey: ctx?.sessionKey,
              },
            )
            .catch((hookErr) => {
              log.warn(
                `after_tool_call hook failed: tool=${normalizeToolName(toolName)} error=${String(hookErr)}`,
              );
            });
        }
      }
    },
  };
}

export const __testing = {
  runBeforeToolCallHook,
  isPlainObject,
};
