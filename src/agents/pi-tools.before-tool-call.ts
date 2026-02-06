import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    const normalizedParams = isPlainObject(args.params) ? args.params : {};
    const hookResult = await hookRunner.runToolResultReceived(
      {
        toolName,
        params: normalizedParams,
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
    log.warn(`tool_result_received hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
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
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startTime = Date.now();

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
      const result = await execute(toolCallId, beforeOutcome.params, signal, onUpdate);
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
}

export const __testing = {
  runBeforeToolCallHook,
  runToolResultReceivedHook,
  isPlainObject,
};
