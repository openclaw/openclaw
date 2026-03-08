import { loadConfig } from "../config/config.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { activeCaMeLOrchestratorScopes, resolveCaMeLScopeKey } from "./camel/active-scopes.js";
import { createApprovalPromptHandler, requestApproval } from "./camel/approval-flow.js";
import { createCapabilities } from "./camel/capabilities.js";
import { resolveCaMeLConfig } from "./camel/config.js";
import { createDefaultPolicies } from "./camel/security-policy.js";
import { SourceKind } from "./camel/types.js";
import { createValue } from "./camel/value.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const camelApprovalHandler = createApprovalPromptHandler();
const CAMEL_TAINT_SOURCE_TOOLS = new Set(["web_fetch", "web_search", "browser", "read"]);
const camelTaintStateByScope = new Map<string, Array<{ text: string; sourceTool: string }>>();
const MAX_CAMEL_TAINT_SCOPES = 128;
const MAX_CAMEL_TAINT_VALUES_PER_SCOPE = 256;
let beforeToolCallRuntimePromise: Promise<
  typeof import("./pi-tools.before-tool-call.runtime.js")
> | null = null;

function getCaMeLTaintState(ctx?: HookContext): Array<{ text: string; sourceTool: string }> {
  const scopeKey = resolveCaMeLScopeKey(ctx);
  const existing = camelTaintStateByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const created: Array<{ text: string; sourceTool: string }> = [];
  camelTaintStateByScope.set(scopeKey, created);
  while (camelTaintStateByScope.size > MAX_CAMEL_TAINT_SCOPES) {
    let evicted = false;
    for (const key of camelTaintStateByScope.keys()) {
      if (!activeCaMeLOrchestratorScopes.has(key)) {
        camelTaintStateByScope.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      break;
    }
  }
  return created;
}

function collectStringLeaves(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 3) {
      into.add(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, into);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(nested, into);
    }
  }
}

function containsTaintedData(
  value: unknown,
  taintValues: Array<{ text: string; sourceTool: string }>,
): { sourceTool: string } | null {
  if (taintValues.length === 0 || value === undefined || value === null) {
    return null;
  }
  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = "";
    }
  }
  if (!raw) {
    return null;
  }
  const rawTrimmed = raw.trim();
  for (const entry of taintValues) {
    if (raw.includes(entry.text)) {
      return { sourceTool: entry.sourceTool };
    }
    // Catch extracted substrings (e.g., email parsed from a tainted page) while
    // avoiding noisy matches on very short/common argument values.
    if (rawTrimmed.length >= 8 && entry.text.includes(rawTrimmed)) {
      return { sourceTool: entry.sourceTool };
    }
  }
  return null;
}

function wrapArgsForCaMeLPolicy(params: {
  args: Record<string, unknown>;
  taintValues: Array<{ text: string; sourceTool: string }>;
}): Record<string, ReturnType<typeof createValue>> {
  const wrapped: Record<string, ReturnType<typeof createValue>> = {};
  for (const [key, value] of Object.entries(params.args)) {
    const taintMatch = containsTaintedData(value, params.taintValues);
    if (taintMatch) {
      wrapped[key] = createValue(
        value,
        createCapabilities({
          sources: [{ kind: "tool", toolName: taintMatch.sourceTool }],
        }),
      );
      continue;
    }
    wrapped[key] = createValue(
      value,
      createCapabilities({
        sources: [SourceKind.Assistant],
      }),
    );
  }
  return wrapped;
}

function trackCaMeLToolResultTaint(args: {
  toolName: string;
  result: unknown;
  ctx?: HookContext;
}): void {
  const normalized = normalizeToolName(args.toolName);
  if (!CAMEL_TAINT_SOURCE_TOOLS.has(normalized)) {
    return;
  }
  const taintValues = getCaMeLTaintState(args.ctx);
  const leaves = new Set<string>();
  collectStringLeaves(args.result, leaves);
  for (const text of leaves) {
    taintValues.push({ text, sourceTool: normalized });
  }
  while (taintValues.length > MAX_CAMEL_TAINT_VALUES_PER_SCOPE) {
    taintValues.shift();
  }
}

async function runCaMeLSecurityCheck(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): Promise<HookOutcome | null> {
  const scopeKey = resolveCaMeLScopeKey(args.ctx);
  if (activeCaMeLOrchestratorScopes.has(scopeKey)) {
    return null;
  }
  const cfg = loadConfig();
  const globalCamel = cfg?.agents?.camel;
  const agentCamel = cfg?.agents?.list?.find((entry) => entry.id === args.ctx?.agentId)?.camel;
  const camelConfig = resolveCaMeLConfig({
    ...globalCamel,
    ...agentCamel,
    policies: {
      ...globalCamel?.policies,
      ...agentCamel?.policies,
    },
  });
  if (!camelConfig.enabled) {
    return null;
  }
  const params = isPlainObject(args.params) ? args.params : {};
  const policyEngine = createDefaultPolicies(camelConfig);
  const wrappedArgs = wrapArgsForCaMeLPolicy({
    args: params,
    taintValues: getCaMeLTaintState(args.ctx),
  });
  const policyResult = policyEngine.checkPolicy(
    args.toolName,
    wrappedArgs,
    Object.values(wrappedArgs),
  );
  if ("allowed" in policyResult) {
    return null;
  }
  const approved = await requestApproval(
    { toolName: args.toolName, reason: policyResult.reason },
    camelApprovalHandler,
  );
  if (approved) {
    return null;
  }
  return { blocked: true, reason: `CaMeL blocked tool execution: ${policyResult.reason}` };
}

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

  const camelOutcome = await runCaMeLSecurityCheck({ toolName, params, ctx: args.ctx });
  if (camelOutcome?.blocked) {
    return camelOutcome;
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
        trackCaMeLToolResultTaint({
          toolName: normalizedToolName,
          result,
          ctx,
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
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
  camelTaintStateByScope,
  trackCaMeLToolResultTaint,
  runBeforeToolCallHook,
  isPlainObject,
};
