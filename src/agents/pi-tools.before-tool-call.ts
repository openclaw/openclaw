import crypto from "node:crypto";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { evaluateToolCall } from "../policy/policy.evaluate.js";
import { getPolicyManagerState } from "../policy/policy.manager.js";
import { isPlainObject } from "../utils.js";
import { requestExecApprovalDecision } from "./bash-tools.exec-approval-request.js";
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
const SENSITIVE_APPROVAL_KEY_RE = /(token|password|secret|api.?key|authorization|cookie)/i;
const MAX_APPROVAL_PARAM_CHARS = 400;
const MAX_APPROVAL_SANITIZE_DEPTH = 3;
const MAX_APPROVAL_ARRAY_ITEMS = 12;

function sanitizeParamsForApproval(value: unknown, depth = 0): unknown {
  if (depth > MAX_APPROVAL_SANITIZE_DEPTH) {
    return "[max-depth]";
  }
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_APPROVAL_ARRAY_ITEMS)
      .map((entry) => sanitizeParamsForApproval(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_APPROVAL_KEY_RE.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitizeParamsForApproval(raw, depth + 1);
  }
  return output;
}

function toApprovalParamsPreview(params: unknown): string {
  try {
    const sanitized = sanitizeParamsForApproval(params);
    const serialized = JSON.stringify(sanitized);
    if (!serialized) {
      return "{}";
    }
    if (serialized.length <= MAX_APPROVAL_PARAM_CHARS) {
      return serialized;
    }
    return `${serialized.slice(0, MAX_APPROVAL_PARAM_CHARS)}...`;
  } catch {
    return "{}";
  }
}

async function requestPolicyToolApproval(args: {
  toolName: string;
  params: unknown;
  reason?: string;
  ctx?: HookContext;
}): Promise<{ approved: boolean; reason?: string }> {
  const command = [
    `policy tool ${normalizeToolName(args.toolName)}`,
    args.reason ? `reason=${args.reason}` : null,
    `params=${toApprovalParamsPreview(args.params)}`,
  ]
    .filter(Boolean)
    .join(" ");
  try {
    const decision = await requestExecApprovalDecision({
      id: crypto.randomUUID(),
      command,
      cwd: process.cwd(),
      host: "gateway",
      security: "allowlist",
      ask: "always",
      agentId: args.ctx?.agentId,
      sessionKey: args.ctx?.sessionKey,
    });
    if (decision === "allow-once" || decision === "allow-always") {
      return { approved: true };
    }
    if (decision === "deny") {
      return { approved: false, reason: "approval denied by operator" };
    }
    return { approved: false, reason: "approval timed out or unavailable" };
  } catch {
    return { approved: false, reason: "approval request failed" };
  }
}

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

  const policyState = await getPolicyManagerState();
  const policyDecision = evaluateToolCall(toolName, params, { state: policyState });
  if (!policyDecision.allow) {
    const reason = policyDecision.reason ?? "operation denied by policy";
    log.warn(`POLICY_DENY tool=${toolName} reason=${reason}`);
    return {
      blocked: true,
      reason: `Denied by policy: ${reason}`,
    };
  }
  if (policyDecision.requireApproval) {
    const approval = await requestPolicyToolApproval({
      toolName,
      params,
      reason: policyDecision.reason,
      ctx: args.ctx,
    });
    if (!approval.approved) {
      const reason = approval.reason ?? "approval required";
      log.warn(`POLICY_DENY tool=${toolName} reason=${reason}`);
      return {
        blocked: true,
        reason: `Denied by policy: ${reason}`,
      };
    }
  }

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
  runBeforeToolCallHook,
  isPlainObject,
};
