import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

// Symbol to mark tools that have already been wrapped with hooks
const HOOK_WRAPPED_SYMBOL = Symbol("hookWrapped");

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

async function runToolResultReceivedHook(args: {
  toolName: string;
  params: unknown;
  result: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  durationMs?: number;
}): Promise<{ blocked: boolean; reason?: string; result: unknown }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("tool_result_received")) {
    return { blocked: false, result: args.result };
  }

  const toolName = normalizeToolName(args.toolName || "tool");
  try {
    const hookResult = await hookRunner.runToolResultReceived(
      {
        toolName,
        params: args.params,
        result: args.result,
        durationMs: args.durationMs,
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
        reason: hookResult.blockReason || "Tool result blocked by plugin hook",
        result: args.result,
      };
    }

    if (hookResult?.result !== undefined) {
      return { blocked: false, result: hookResult.result };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(
      `tool_result_received hook failed: tool=${toolName}${toolCallId} error=${String(err)}`,
    );
  }

  return { blocked: false, result: args.result };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  // Return early if tool is already wrapped (idempotent)
  if ((tool as unknown as Record<symbol, unknown>)[HOOK_WRAPPED_SYMBOL]) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Before hook - can modify params or block the call
      const beforeOutcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (beforeOutcome.blocked) {
        throw new Error(beforeOutcome.reason);
      }

      // Execute the tool
      const startTime = Date.now();
      const result = await execute(toolCallId, beforeOutcome.params, signal, onUpdate);
      // Pure tool execution time (excludes hook overhead)
      const durationMs = Date.now() - startTime;

      // After hook - can modify result or block it
      const afterOutcome = await runToolResultReceivedHook({
        toolName,
        params: beforeOutcome.params,
        result,
        toolCallId,
        ctx,
        durationMs,
      });
      if (afterOutcome.blocked) {
        throw new Error(afterOutcome.reason);
      }

      // oxlint-disable-next-line typescript/no-explicit-any
      return afterOutcome.result as any;
    },
  };
  // Mark as wrapped to prevent double-wrapping
  (wrappedTool as unknown as Record<symbol, unknown>)[HOOK_WRAPPED_SYMBOL] = true;
  return wrappedTool;
}

export const __testing = {
  runBeforeToolCallHook,
  runToolResultReceivedHook,
  isPlainObject,
};
