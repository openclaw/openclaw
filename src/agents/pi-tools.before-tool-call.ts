import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "./tools/common.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  toolCallId?: string;
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
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const hookSessionKey = args.ctx?.sessionKey ?? `tool:${toolName}`;
  try {
    const hookEvent = createInternalHookEvent("agent", "tool:start", hookSessionKey, {
      toolName,
      toolCallId: args.toolCallId ?? args.ctx?.toolCallId,
      params: isPlainObject(params) ? params : undefined,
    });
    await triggerInternalHook(hookEvent);
  } catch (err) {
    log.warn(`agent:tool:start hook failed: tool=${toolName} error=${String(err)}`);
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }
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
        toolCallId: args.toolCallId ?? args.ctx?.toolCallId,
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

export async function runAfterToolCallHook(args: {
  toolName: string;
  params: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<void> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = isPlainObject(args.params) ? args.params : {};
  const hookSessionKey = args.ctx?.sessionKey ?? `tool:${toolName}`;
  try {
    const hookEvent = createInternalHookEvent("agent", "tool:end", hookSessionKey, {
      toolName,
      toolCallId: args.toolCallId ?? args.ctx?.toolCallId,
      params,
      result: args.result,
      error: args.error,
      durationMs: args.durationMs,
    });
    await triggerInternalHook(hookEvent);
  } catch (err) {
    log.warn(`agent:tool:end hook failed: tool=${toolName} error=${String(err)}`);
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_tool_call")) {
    return;
  }
  try {
    await hookRunner.runAfterToolCall(
      {
        toolName,
        params,
        result: args.result,
        error: args.error,
        durationMs: args.durationMs,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
        toolCallId: args.toolCallId ?? args.ctx?.toolCallId,
      },
    );
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`after_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }
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
      // TODO(hooks): Prefer real toolCallId once all tool sources supply it consistently.
      const hookToolCallId =
        typeof toolCallId === "string" && toolCallId.trim() ? toolCallId : `hook-${randomUUID()}`;
      const startedAt = Date.now();
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId: hookToolCallId,
        ctx: {
          ...ctx,
          toolCallId: hookToolCallId,
        },
      });
      if (outcome.blocked) {
        await runAfterToolCallHook({
          toolName,
          params: outcome.params,
          error: outcome.reason,
          durationMs: Date.now() - startedAt,
          toolCallId: hookToolCallId,
          ctx: {
            ...ctx,
            toolCallId: hookToolCallId,
          },
        });
        throw new Error(outcome.reason);
      }
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await runAfterToolCallHook({
          toolName,
          params: outcome.params,
          result,
          durationMs: Date.now() - startedAt,
          toolCallId: hookToolCallId,
          ctx: {
            ...ctx,
            toolCallId: hookToolCallId,
          },
        });
        return result;
      } catch (err) {
        await runAfterToolCallHook({
          toolName,
          params: outcome.params,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
          toolCallId: hookToolCallId,
          ctx: {
            ...ctx,
            toolCallId: hookToolCallId,
          },
        });
        throw err;
      }
    },
  };
}

export const __testing = {
  runBeforeToolCallHook,
  runAfterToolCallHook,
  isPlainObject,
};
