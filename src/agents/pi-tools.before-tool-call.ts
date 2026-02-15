import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "./tools/common.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
  toolCallId?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;

function resolveHookSessionKey(
  ctxSessionKey: string | undefined,
  agentId: string | undefined,
  toolCallId: string | undefined,
): string {
  if (typeof ctxSessionKey === "string" && ctxSessionKey.trim().length > 0) {
    return ctxSessionKey;
  }
  const normalizedAgentId =
    typeof agentId === "string" && agentId.trim().length > 0 ? agentId : "unknown";
  if (typeof toolCallId === "string" && toolCallId.trim().length > 0) {
    return `tool:${normalizedAgentId}:${toolCallId}`;
  }
  return `tool:${normalizedAgentId}:unknown`;
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const candidateToolCallId = args.toolCallId ?? args.ctx?.toolCallId;
  const effectiveToolCallId =
    typeof candidateToolCallId === "string" && candidateToolCallId.trim()
      ? candidateToolCallId
      : `hook-${randomUUID()}`;
  const hookSessionKey = resolveHookSessionKey(
    args.ctx?.sessionKey,
    args.ctx?.agentId,
    effectiveToolCallId,
  );
  try {
    const hookEvent = createInternalHookEvent("agent", "tool:start", hookSessionKey, {
      toolName,
      toolCallId: effectiveToolCallId,
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
        toolCallId: effectiveToolCallId,
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
  const candidateToolCallId = args.toolCallId ?? args.ctx?.toolCallId;
  const effectiveToolCallId =
    typeof candidateToolCallId === "string" && candidateToolCallId.trim()
      ? candidateToolCallId
      : `hook-${randomUUID()}`;
  const hookSessionKey = resolveHookSessionKey(
    args.ctx?.sessionKey,
    args.ctx?.agentId,
    effectiveToolCallId,
  );
  try {
    const hookEvent = createInternalHookEvent("agent", "tool:end", hookSessionKey, {
      toolName,
      toolCallId: effectiveToolCallId,
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
        toolCallId: effectiveToolCallId,
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
  const wrappedTool: AnyAgentTool = {
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
          params,
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
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: false,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  runAfterToolCallHook,
  isPlainObject,
};
