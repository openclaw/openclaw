import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookToolResultBeforeModelEvent } from "../plugins/types.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  /** When true, plugins may inject or replace tool results. Default: false. */
  allowResultModification?: boolean;
};

type HookOutcome =
  | { blocked: true; reason: string }
  | { blocked: false; params: unknown; injectedResult?: undefined }
  | { blocked: false; params: unknown; injectedResult: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
let beforeToolCallRuntimePromise: Promise<
  typeof import("./pi-tools.before-tool-call.runtime.js")
> | null = null;

function loadBeforeToolCallRuntime() {
  beforeToolCallRuntimePromise ??= import("./pi-tools.before-tool-call.runtime.js");
  return beforeToolCallRuntimePromise;
}

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId ? { agentId: args.ctx.agentId } : {}),
      ...(args.ctx?.sessionKey ? { sessionKey: args.ctx.sessionKey } : {}),
      ...(args.ctx?.sessionId ? { sessionId: args.ctx.sessionId } : {}),
      ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId ? { runId: args.ctx.runId } : {}),
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.result !== undefined) {
      if (args.ctx?.allowResultModification !== true) {
        log.warn(
          `[security] before_tool_call result injection blocked for ${toolName}: ` +
            `plugins.allowResultModification is not enabled`,
        );
      } else {
        const mergedParams =
          hookResult.params && isPlainObject(hookResult.params) && isPlainObject(params)
            ? { ...params, ...hookResult.params }
            : params;
        return { blocked: false, params: mergedParams, injectedResult: hookResult.result };
      }
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

export async function runToolResultBeforeModelHook(args: {
  toolName: string;
  toolCallId?: string;
  params: unknown;
  result: unknown;
  ctx?: HookContext;
}): Promise<AgentToolResult<unknown>> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("tool_result_before_model")) {
    return args.result as AgentToolResult<unknown>;
  }
  try {
    const normalizedParams = isPlainObject(args.params) ? args.params : {};
    const event: PluginHookToolResultBeforeModelEvent = {
      toolName: normalizeToolName(args.toolName),
      toolCallId: args.toolCallId,
      params: normalizedParams,
      result: args.result,
    };
    const hookResult = await hookRunner.runToolResultBeforeModel(event, {
      toolName: normalizeToolName(args.toolName),
      toolCallId: args.toolCallId,
      agentId: args.ctx?.agentId,
      sessionKey: args.ctx?.sessionKey,
      sessionId: args.ctx?.sessionId,
      runId: args.ctx?.runId,
    });
    if (hookResult?.result !== undefined) {
      if (args.ctx?.allowResultModification !== true) {
        log.warn(
          `[security] tool_result_before_model result replacement blocked for ${args.toolName}: ` +
            `plugins.allowResultModification is not enabled`,
        );
        return args.result as AgentToolResult<unknown>;
      }
      return hookResult.result as AgentToolResult<unknown>;
    }
  } catch (err) {
    log.warn(`tool_result_before_model hook failed: tool=${args.toolName} error=${String(err)}`);
  }
  return args.result as AgentToolResult<unknown>;
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
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (!outcome.blocked && outcome.injectedResult !== undefined) {
        if (toolCallId) {
          const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
          adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
          if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
            const oldest = adjustedParamsByToolCallId.keys().next().value;
            if (oldest) {
              adjustedParamsByToolCallId.delete(oldest);
            }
          }
        }
        return runToolResultBeforeModelHook({
          toolName,
          toolCallId,
          params: outcome.params,
          result: outcome.injectedResult,
          ctx,
        });
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return runToolResultBeforeModelHook({
          toolName,
          toolCallId,
          params: outcome.params,
          result,
          ctx,
        });
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        // Let tool_result_before_model intercept error results too.
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorResult: AgentToolResult<unknown> = {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          details: { error: true },
        };
        const hookProcessed = await runToolResultBeforeModelHook({
          toolName,
          toolCallId,
          params: outcome.params,
          result: errorResult,
          ctx,
        });
        if (hookProcessed !== errorResult) {
          return hookProcessed;
        }
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
