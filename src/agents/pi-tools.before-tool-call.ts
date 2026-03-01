import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
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
  workspaceDir?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const actorWebPageUsage = new Map<string, number>();

type ToolPermissionsFile = {
  executive_orchestrator?: {
    allowed_tools?: string[];
    forbidden_tools?: string[];
    write_scopes?: string[];
    max_pages?: number;
  };
};

type SubagentsRegistryFile = {
  subagents?: Array<{
    subagent_id?: string;
    allowed_tools?: string[];
    forbidden_tools?: string[];
    write_scopes?: string[];
    max_pages?: number;
  }>;
};

type ActorPermissionPolicy = {
  actor: string;
  allowedTools: Set<string>;
  forbiddenTools: Set<string>;
  writeScopes: string[];
  maxPages: number;
};

type PermissionContracts = {
  executive?: ToolPermissionsFile["executive_orchestrator"];
  subagents?: SubagentsRegistryFile["subagents"];
};

const permissionsCache = new Map<string, PermissionContracts>();

function normalizePermissionToken(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim().toLowerCase();
  }
  return "";
}

function parseYamlFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = readFileSync(path, "utf8");
    return parseYaml(raw) as T;
  } catch (err) {
    log.warn(`tool permissions parse failed for ${path}: ${String(err)}`);
    return undefined;
  }
}

function loadPermissionContracts(workspaceDir?: string): PermissionContracts | undefined {
  if (!workspaceDir) {
    return undefined;
  }
  const cached = permissionsCache.get(workspaceDir);
  if (cached) {
    return cached;
  }
  const toolPermissionsPath = join(workspaceDir, "01_agent_os/core/tool_permissions.yaml");
  const subagentsRegistryPath = join(workspaceDir, "01_agent_os/behavior/subagents_registry.yaml");
  const toolPermissions = parseYamlFile<ToolPermissionsFile>(toolPermissionsPath);
  const subagentsRegistry = parseYamlFile<SubagentsRegistryFile>(subagentsRegistryPath);
  if (!toolPermissions && !subagentsRegistry) {
    return undefined;
  }
  const loaded: PermissionContracts = {
    executive: toolPermissions?.executive_orchestrator,
    subagents: subagentsRegistry?.subagents,
  };
  permissionsCache.set(workspaceDir, loaded);
  return loaded;
}

function resolveActorPolicy(ctx?: HookContext): ActorPermissionPolicy | undefined {
  const contracts = loadPermissionContracts(ctx?.workspaceDir);
  if (!contracts) {
    return undefined;
  }
  const agentId = normalizePermissionToken(ctx?.agentId);
  const isExecutive =
    agentId === "main" || agentId === "executive_orchestrator" || agentId === "don_cordazzo";
  if (isExecutive && contracts.executive) {
    return {
      actor: "executive_orchestrator",
      allowedTools: new Set(
        (contracts.executive.allowed_tools ?? []).map(normalizePermissionToken),
      ),
      forbiddenTools: new Set(
        (contracts.executive.forbidden_tools ?? []).map(normalizePermissionToken),
      ),
      writeScopes: contracts.executive.write_scopes ?? [],
      maxPages: Number(contracts.executive.max_pages ?? 0),
    };
  }
  const subagent = (contracts.subagents ?? []).find(
    (entry) => normalizePermissionToken(entry?.subagent_id) === agentId,
  );
  if (!subagent) {
    return undefined;
  }
  return {
    actor: agentId,
    allowedTools: new Set((subagent.allowed_tools ?? []).map(normalizePermissionToken)),
    forbiddenTools: new Set((subagent.forbidden_tools ?? []).map(normalizePermissionToken)),
    writeScopes: subagent.write_scopes ?? [],
    maxPages: Number(subagent.max_pages ?? 0),
  };
}

function mapRuntimeToolToPermission(toolName: string): string {
  switch (toolName) {
    case "browser":
      return "web_browsing";
    case "message":
      return "send_message";
    case "read":
      return "file_read";
    case "write":
    case "edit":
    case "apply_patch":
      return "file_write";
    default:
      return toolName;
  }
}

function parseWritePath(toolName: string, params: unknown): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const pathLike =
    params.file_path ?? params.path ?? params.target_file ?? params.output_path ?? params.filename;
  if (typeof pathLike === "string" && pathLike.trim().length > 0) {
    return pathLike.trim();
  }
  if (toolName !== "apply_patch") {
    return undefined;
  }
  const input = params.input;
  if (typeof input !== "string") {
    return undefined;
  }
  const match = input.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/m);
  if (!match) {
    return undefined;
  }
  return match[1].trim();
}

function writePathAllowed(writePath: string, scopes: string[]): boolean {
  const normalized = writePath.trim().replace(/^\/+/, "");
  return scopes.some((scope) => normalized.startsWith(scope.trim().replace(/^\/+/, "")));
}

function evaluateContractPolicy(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): string | undefined {
  const actorPolicy = resolveActorPolicy(args.ctx);
  if (!actorPolicy) {
    return undefined;
  }
  const permissionTool = mapRuntimeToolToPermission(args.toolName);

  if (actorPolicy.forbiddenTools.has(permissionTool)) {
    return `forbidden by actor policy (${actorPolicy.actor}): ${permissionTool}`;
  }
  if (actorPolicy.allowedTools.size > 0 && !actorPolicy.allowedTools.has(permissionTool)) {
    return `tool not allowed for ${actorPolicy.actor}: ${permissionTool}`;
  }
  if (permissionTool === "web_browsing") {
    if (actorPolicy.maxPages <= 0) {
      return `web browsing disabled for ${actorPolicy.actor}`;
    }
    const actorKey = `${actorPolicy.actor}:${args.ctx?.sessionKey ?? "session"}`;
    const used = actorWebPageUsage.get(actorKey) ?? 0;
    const next = used + 1;
    if (next > actorPolicy.maxPages) {
      return `max pages exceeded for ${actorPolicy.actor}: ${next}>${actorPolicy.maxPages}`;
    }
    actorWebPageUsage.set(actorKey, next);
  }
  if (permissionTool === "file_write") {
    const writePath = parseWritePath(args.toolName, args.params);
    if (!writePath) {
      return `missing write path for scoped actor ${actorPolicy.actor}`;
    }
    if (
      actorPolicy.writeScopes.length > 0 &&
      !writePathAllowed(writePath, actorPolicy.writeScopes)
    ) {
      return `write scope violation for ${actorPolicy.actor}: ${writePath}`;
    }
  }
  return undefined;
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
  const params = args.params;
  const policyBlockReason = evaluateContractPolicy({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (policyBlockReason) {
    return {
      blocked: true,
      reason: policyBlockReason,
    };
  }

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
