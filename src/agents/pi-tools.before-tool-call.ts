import crypto from "node:crypto";
import type { ToolApprovalConfig } from "../config/types.approvals.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { compileSafeRegex } from "../security/safe-regex.js";
import { isPlainObject } from "../utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { requestExecApprovalDecision } from "./bash-tools.exec-approval-request.js";
import { buildToolActionFingerprint, isMutatingToolCall } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  loopDetection?: ToolLoopDetectionConfig;
  approvals?: {
    tools?: ToolApprovalConfig;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
    cwd?: string;
  };
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_APPROVAL_ALLOW_ALWAYS_TTL_MS = 21_600_000;
const MAX_TOOL_APPROVAL_CACHE = 2_048;
const DEFAULT_SELECTED_TOOL_APPROVALS = new Set(["apply_patch"]);
const toolApprovalAllowAlwaysCache = new Map<string, number>();
const TOOL_APPROVAL_COMMAND_PREVIEW_MAX = 140;
const TOOL_APPROVAL_CONTEXT_PREVIEW_MAX = 80;
const TOOL_APPROVAL_COMMAND_FIELDS = [
  "cmd",
  "command",
  "shellCommand",
  "rawCommand",
  "invokeCommand",
  "ptyCommand",
];
const TOOL_APPROVAL_REASON_FIELDS = ["justification", "reason", "purpose", "description"];

function normalizeApprovalList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => normalizeToolName(value || ""))
    .filter((value): value is string => value.length > 0);
}

function matchesSessionFilter(sessionKey: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (sessionKey.includes(pattern)) {
      return true;
    }
    const regex = compileSafeRegex(pattern);
    return regex ? regex.test(sessionKey) : false;
  });
}

function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.min(rounded, max);
}

function sanitizeApprovalField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truncateApprovalPreview(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function summarizeToolCallForApproval(toolName: string, params: unknown): string {
  const record = isPlainObject(params) ? params : {};
  const action = sanitizeApprovalField(record.action)?.replace(/\s+/g, "_");
  const commandField = TOOL_APPROVAL_COMMAND_FIELDS.find((field) =>
    sanitizeApprovalField(record[field]),
  );
  const commandValue = commandField ? sanitizeApprovalField(record[commandField]) : undefined;
  const reasonField = TOOL_APPROVAL_REASON_FIELDS.find((field) =>
    sanitizeApprovalField(record[field]),
  );
  const reasonValue = reasonField ? sanitizeApprovalField(record[reasonField]) : undefined;
  const targetKey = ["path", "filePath", "oldPath", "newPath", "target", "to", "id"].find((key) =>
    sanitizeApprovalField(record[key]),
  );
  const targetValue = targetKey ? sanitizeApprovalField(record[targetKey]) : undefined;
  const parts = [`tool:${toolName}`];
  if (action) {
    parts.push(`action:${action}`);
  }
  if (commandValue) {
    const normalizedCommand = truncateApprovalPreview(
      commandValue.replace(/\s+/g, " "),
      TOOL_APPROVAL_COMMAND_PREVIEW_MAX,
    );
    parts.push(`cmd:${normalizedCommand}`);
  }
  if (reasonValue) {
    const normalizedReason = truncateApprovalPreview(
      reasonValue.replace(/\s+/g, " "),
      TOOL_APPROVAL_COMMAND_PREVIEW_MAX,
    );
    parts.push(`why:${normalizedReason}`);
  }
  if (targetKey && targetValue) {
    const shortValue = truncateApprovalPreview(targetValue, TOOL_APPROVAL_CONTEXT_PREVIEW_MAX);
    parts.push(`${targetKey}:${shortValue}`);
  }
  return parts.join(" ");
}

function resolveToolApprovalScopeKey(args: {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  actionFingerprint?: string;
}): string {
  const parts = [
    `agent=${args.agentId ?? ""}`,
    `session=${args.sessionKey ?? ""}`,
    `tool=${args.toolName}`,
  ];
  if (args.actionFingerprint) {
    parts.push(`fingerprint=${args.actionFingerprint}`);
  }
  return parts.join("|");
}

function pruneToolApprovalCache(nowMs: number): void {
  for (const [key, expiresAtMs] of toolApprovalAllowAlwaysCache) {
    if (expiresAtMs <= nowMs) {
      toolApprovalAllowAlwaysCache.delete(key);
    }
  }
  while (toolApprovalAllowAlwaysCache.size > MAX_TOOL_APPROVAL_CACHE) {
    const oldest = toolApprovalAllowAlwaysCache.keys().next().value;
    if (!oldest) {
      break;
    }
    toolApprovalAllowAlwaysCache.delete(oldest);
  }
}

function resolveToolApprovalCwd(params: unknown, ctx?: HookContext): string {
  const record = isPlainObject(params) ? params : {};
  const fromWorkdir = sanitizeApprovalField(record.workdir);
  if (fromWorkdir) {
    return fromWorkdir;
  }
  const fromCwd = sanitizeApprovalField(record.cwd);
  if (fromCwd) {
    return fromCwd;
  }
  const fromContext = sanitizeApprovalField(ctx?.approvals?.cwd);
  if (fromContext) {
    return fromContext;
  }
  return process.cwd();
}

async function maybeEnforceToolApproval(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): Promise<HookOutcome | null> {
  const cfg = args.ctx?.approvals?.tools;
  if (!cfg?.enabled) {
    return null;
  }
  if (cfg.agentFilter?.length) {
    const agentId = args.ctx?.agentId;
    if (!agentId || !cfg.agentFilter.includes(agentId)) {
      return null;
    }
  }
  if (cfg.sessionFilter?.length) {
    const sessionKey = args.ctx?.sessionKey;
    if (!sessionKey || !matchesSessionFilter(sessionKey, cfg.sessionFilter)) {
      return null;
    }
  }
  const mode = cfg.mode === "mutating" ? "mutating" : "selected";
  const selectedTools = normalizeApprovalList(cfg.tools);
  const selectedSet =
    selectedTools.length > 0 ? new Set(selectedTools) : DEFAULT_SELECTED_TOOL_APPROVALS;
  const requiresApproval =
    mode === "mutating"
      ? isMutatingToolCall(args.toolName, args.params)
      : selectedSet.has(args.toolName);
  if (!requiresApproval) {
    return null;
  }

  const nowMs = Date.now();
  const actionFingerprint = buildToolActionFingerprint(args.toolName, args.params);
  const scopeKey = resolveToolApprovalScopeKey({
    agentId: args.ctx?.agentId,
    sessionKey: args.ctx?.sessionKey,
    toolName: args.toolName,
    actionFingerprint,
  });
  const cachedUntil = toolApprovalAllowAlwaysCache.get(scopeKey);
  if (cachedUntil && cachedUntil > nowMs) {
    return null;
  }
  if (cachedUntil && cachedUntil <= nowMs) {
    toolApprovalAllowAlwaysCache.delete(scopeKey);
  }

  const timeoutMs = normalizePositiveInt(
    cfg.timeoutMs,
    DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
    3_600_000,
  );
  const allowAlwaysTtlMs = normalizePositiveInt(
    cfg.allowAlwaysTtlMs,
    DEFAULT_TOOL_APPROVAL_ALLOW_ALWAYS_TTL_MS,
    86_400_000,
  );
  const failClosed = cfg.failClosed !== false;
  const security = cfg.security === "deny" || cfg.security === "allowlist" ? cfg.security : "full";
  const ask = cfg.ask === "off" || cfg.ask === "on-miss" ? cfg.ask : "always";
  const turnSourceChannel = normalizeMessageChannel(args.ctx?.approvals?.turnSourceChannel ?? "");

  try {
    const decision = await requestExecApprovalDecision({
      id: `tool-${crypto.randomUUID()}`,
      command: summarizeToolCallForApproval(args.toolName, args.params),
      commandArgv: [args.toolName],
      cwd: resolveToolApprovalCwd(args.params, args.ctx),
      host: "gateway",
      security,
      ask,
      agentId: args.ctx?.agentId,
      resolvedPath: actionFingerprint,
      sessionKey: args.ctx?.sessionKey,
      turnSourceChannel: turnSourceChannel ?? undefined,
      turnSourceTo: args.ctx?.approvals?.turnSourceTo,
      turnSourceAccountId: args.ctx?.approvals?.turnSourceAccountId,
      turnSourceThreadId: args.ctx?.approvals?.turnSourceThreadId,
      timeoutMs,
    });

    if (decision === "allow-always") {
      toolApprovalAllowAlwaysCache.set(scopeKey, nowMs + allowAlwaysTtlMs);
      pruneToolApprovalCache(nowMs);
      return null;
    }
    if (decision === "allow-once") {
      return null;
    }
    if (decision === "deny") {
      return {
        blocked: true,
        reason: `Tool call denied by operator: ${args.toolName}`,
      };
    }
    return {
      blocked: true,
      reason: `Tool call denied (approval expired or unavailable): ${args.toolName}`,
    };
  } catch (err) {
    if (!failClosed) {
      log.warn(`tool approval request failed open: tool=${args.toolName} error=${String(err)}`);
      return null;
    }
    return {
      blocked: true,
      reason: `Tool call denied (approval request failed): ${args.toolName}`,
    };
  }
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
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { recordToolCallOutcome } = await import("./tool-loop-detection.js");
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
  let params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { logToolLoopAction } = await import("../logging/diagnostic.js");
    const { detectToolCallLoop, recordToolCall } = await import("./tool-loop-detection.js");

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
  if (hookRunner?.hasHooks("before_tool_call")) {
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
          params = { ...params, ...hookResult.params };
        } else {
          params = hookResult.params;
        }
      }
    } catch (err) {
      const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
      log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
    }
  }

  const toolApprovalOutcome = await maybeEnforceToolApproval({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (toolApprovalOutcome) {
    return toolApprovalOutcome;
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
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
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

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  toolApprovalAllowAlwaysCache,
  clearToolApprovalAllowAlwaysCache: () => {
    toolApprovalAllowAlwaysCache.clear();
  },
  runBeforeToolCallHook,
  isPlainObject,
};
