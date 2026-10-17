/**
 * Owns hook execution, client-tool delegation, result coercion, and safe
 * logging for failed tool calls.
 */
import { logDebug, logError } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { isPlainObject } from "../utils.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  buildBlockedToolResult,
  isToolWrappedWithBeforeToolCallHook,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  finalizeBeforeToolCallExecutionParams,
  prepareBeforeToolCallExecutionParams,
} from "./agent-tools.before-tool-call.wrapper.js";
import {
  createInternalExecutionPreparer,
  readInternalExecutionControl,
} from "./agent-tools.execution-preparer.js";
import {
  copyCodeModeControlToolIdentity,
  getCodeModeExecBeforeHookMetadata,
  normalizeCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import { readNodePermissionError } from "./node-permission-error.js";
import { projectAgentToolDefinition } from "./prepared-tool-surface.js";
import type { AgentTool as AnyAgentTool, AgentToolResult } from "./runtime/index.js";
import {
  attachInternalToolExecutionPreparer,
  copyInternalToolResultState,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import type { ToolDefinition } from "./sessions/index.js";
import { readToolOperatorHint } from "./tool-operator-hint.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { jsonResult, payloadTextResult, ToolInputError } from "./tools/common.js";

type ToolExecuteArgs = Parameters<ToolDefinition["execute"]>;

type ClientToolCallRecorder =
  | ((toolName: string, params: Record<string, unknown>) => void)
  | {
      reserve?: (toolCallId: string, toolName: string) => void;
      complete: (toolCallId: string, toolName: string, params: Record<string, unknown>) => void;
      discard?: (toolCallId: string, toolName: string) => void;
    };

function describeToolExecutionError(err: unknown): {
  message: string;
  operatorHint?: string;
} {
  const operatorHint = readToolOperatorHint(err);
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, ...(operatorHint ? { operatorHint } : {}) };
  }
  return { message: String(err) };
}

function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    return payloadTextResult(
      ("details" in record ? record.details : record) ?? { status: "ok", tool: toolName },
    );
  }
  return payloadTextResult(result ?? { status: "ok", tool: toolName });
}

function buildToolExecutionErrorResult(params: {
  toolName: string;
  message: string;
  cause?: unknown;
}): AgentToolResult<unknown> {
  const permissionMissing = readNodePermissionError(params.cause);
  return jsonResult({
    status: "error",
    tool: params.toolName,
    error: params.message,
    ...(permissionMissing ? { permissionMissing } : {}),
  });
}

async function executeAdaptedToolOperation(params: {
  normalizedToolName: string;
  signal: AbortSignal | undefined;
  run: () => Promise<unknown>;
}): Promise<AgentToolResult<unknown>> {
  try {
    return normalizeToolExecutionResult({
      toolName: params.normalizedToolName,
      result: await params.run(),
    });
  } catch (err) {
    if (params.signal?.aborted) {
      throw err;
    }
    const described = describeToolExecutionError(err);
    const operatorHint = described.operatorHint ? ` ${described.operatorHint}` : "";
    // Operator-only: the hint names containment configuration and stays out of the
    // model-visible result below.
    logError(`[tools] ${params.normalizedToolName} failed:${operatorHint}`);
    const result = buildToolExecutionErrorResult({
      toolName: params.normalizedToolName,
      message: described.message,
      cause: err,
    });
    // Error presentation must preserve private execution and content provenance.
    return typeof err === "object" && err !== null
      ? copyInternalToolResultState(err, result)
      : result;
  }
}

function attachAdapterExecutionPreparer<T extends ToolDefinition>(definition: T): T {
  return attachInternalToolExecutionPreparer(
    definition,
    createInternalExecutionPreparer((params, control) =>
      definition.execute(
        params.toolCallId,
        params.args,
        params.signal,
        params.onUpdate,
        control as never,
      ),
    ),
  );
}

export const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

export function findClientToolNameConflicts(params: {
  tools: ClientToolDefinition[];
  existingToolNames?: Iterable<string>;
}): string[] {
  const existingNormalized = new Set<string>();
  for (const name of params.existingToolNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      existingNormalized.add(normalizeToolPolicyName(trimmed));
    }
  }

  const conflicts = new Set<string>();
  const seenClientNames = new Map<string, string>();
  for (const tool of params.tools) {
    const rawName = (tool.function?.name ?? "").trim();
    if (!rawName) {
      continue;
    }
    const normalizedName = normalizeToolPolicyName(rawName);
    if (existingNormalized.has(normalizedName)) {
      conflicts.add(rawName);
    }
    const priorClientName = seenClientNames.get(normalizedName);
    if (priorClientName) {
      conflicts.add(priorClientName);
      conflicts.add(rawName);
      continue;
    }
    seenClientNames.set(normalizedName, rawName);
  }
  return Array.from(conflicts);
}

/** Detect client tool conflict errors without depending on object identity. */
export function isClientToolNameConflictError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}

export function toToolDefinitions(
  tools: AnyAgentTool[],
  hookContext?: HookContext,
  abortSignal?: AbortSignal,
): ToolDefinition[] {
  // Adaptation installs policy hooks outside source tools. Bind their lifetime
  // here too, so revoked generations cannot leave approvals waiting upstream.
  const resolveAbortSignal = (signal?: AbortSignal) =>
    signal && abortSignal ? AbortSignal.any([signal, abortSignal]) : (signal ?? abortSignal);
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const toolOwnerPluginId = getPluginToolMeta(tool)?.pluginId;
    const normalizedName = normalizeToolPolicyName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    const sourcePreparer = getInternalToolExecutionPreparer(tool);
    const definition = {
      ...projectAgentToolDefinition(tool),
      prepareArguments: tool.prepareArguments,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const [toolCallId, params, callSignal, onUpdate] = args;
        const signal = resolveAbortSignal(callSignal);
        signal?.throwIfAborted();
        const control = readInternalExecutionControl(args[4]);
        recordStructuredReplayTrustForToolCall(toolCallId, tool, hookContext?.runId);
        let executeParams = params;
        return await executeAdaptedToolOperation({
          normalizedToolName: normalizedName,
          signal,
          run: async () => {
            if (!beforeHookWrapped) {
              const preparedParams = await prepareBeforeToolCallExecutionParams({
                tool,
                params,
                ...(toolCallId ? { toolCallId } : {}),
                ...(hookContext ? { ctx: hookContext } : {}),
                ...(signal ? { signal } : {}),
              });
              const hookParams = normalizeCodeModeExecBeforeHookParams({
                tool,
                params: preparedParams,
              });
              const hookMetadata = getCodeModeExecBeforeHookMetadata({
                tool,
                params: preparedParams,
              });
              const hookOutcome = await runBeforeToolCallHook({
                toolName: name,
                params: hookParams,
                ...hookMetadata,
                toolCallId,
                ctx: hookContext
                  ? { ...hookContext, toolOwnerPluginId }
                  : toolOwnerPluginId
                    ? { toolOwnerPluginId }
                    : undefined,
                signal,
              });
              if (hookOutcome.blocked) {
                if (hookOutcome.kind === "veto") {
                  return buildBlockedToolResult({
                    reason: hookOutcome.reason,
                    deniedReason: hookOutcome.deniedReason,
                    toolCallId,
                    runId: hookContext?.runId,
                  });
                }
                throw new Error(hookOutcome.reason);
              }
              executeParams = finalizeBeforeToolCallExecutionParams({
                tool,
                preparedParams,
                hookParams,
                adjustedParams: hookOutcome.params,
                finalizerMode: "adapter",
              });
              const decision = control ? await control.pause(executeParams) : undefined;
              if (decision && !decision.launch) {
                return { content: [], details: { status: "skipped" } };
              }
              decision?.start?.();
              recordAdjustedParamsForToolCall(toolCallId, executeParams, hookContext?.runId);
            }
            return await tool.execute(toolCallId, executeParams, signal, onUpdate);
          },
        });
      },
    } satisfies ToolDefinition;
    copyCodeModeControlToolIdentity(tool, definition);
    if (!sourcePreparer) {
      return beforeHookWrapped ? definition : attachAdapterExecutionPreparer(definition);
    }
    return attachInternalToolExecutionPreparer(definition, async (params) => {
      const signal = resolveAbortSignal(params.signal);
      signal?.throwIfAborted();
      recordStructuredReplayTrustForToolCall(params.toolCallId, tool, hookContext?.runId);
      const settle = (run: () => Promise<unknown>) =>
        executeAdaptedToolOperation({
          normalizedToolName: normalizedName,
          signal,
          run,
        });
      type ImmediateOutcome = Extract<
        Awaited<ReturnType<typeof sourcePreparer>>,
        { kind: "immediate" }
      >["outcome"];
      const settleImmediate = async (outcome: ImmediateOutcome, dispose: () => void) => {
        let settled: ImmediateOutcome;
        try {
          const result = await settle(async () => {
            if (outcome.kind === "error") {
              throw outcome.error;
            }
            return outcome.result;
          });
          settled = {
            kind: "result",
            result,
            isError: outcome.kind === "result" && outcome.isError,
          };
        } catch (error) {
          settled = { kind: "error", error };
        }
        return { kind: "immediate" as const, outcome: settled, dispose };
      };
      let prepared: Awaited<ReturnType<typeof sourcePreparer>>;
      try {
        prepared = await sourcePreparer({
          toolCallId: params.toolCallId,
          args: params.args,
          ...(signal ? { signal } : {}),
          ...(params.onUpdate ? { onUpdate: params.onUpdate } : {}),
        });
      } catch (error) {
        return await settleImmediate({ kind: "error", error }, () => {});
      }
      if (prepared.kind === "immediate") {
        return await settleImmediate(prepared.outcome, prepared.dispose);
      }
      const ready = prepared;
      return {
        kind: "ready",
        args: ready.args,
        execute: (onImplementationStart) => {
          signal?.throwIfAborted();
          return settle(() => ready.execute(onImplementationStart));
        },
        dispose: ready.dispose,
      };
    });
  });
}

function coerceParamsRecord(
  value: unknown,
  schema: ClientToolDefinition["function"]["parameters"],
): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      parsed = trimmed ? JSON.parse(trimmed) : undefined;
    } catch {
      throw new ToolInputError("Invalid client tool arguments: expected a JSON object");
    }
  }
  const record = parsed ?? {};
  if (!isPlainObject(record)) {
    throw new ToolInputError("Invalid client tool arguments: expected a JSON object");
  }

  const required = Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    throw new ToolInputError(
      `Invalid client tool arguments: missing required ${missing.join(", ")}`,
    );
  }
  return record;
}

export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: ClientToolCallRecorder,
  hookContext?: HookContext,
): ToolDefinition[] {
  const recorder = typeof onClientToolCall === "object" ? onClientToolCall : undefined;
  return tools.map((tool) => {
    const func = tool.function;
    const definition = {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const [toolCallId, params, signal] = args;
        const control = readInternalExecutionControl(args[4]);
        recorder?.reserve?.(toolCallId, func.name);
        try {
          const initialParamsRecord = coerceParamsRecord(params, func.parameters);
          const outcome = await runBeforeToolCallHook({
            toolName: func.name,
            params: initialParamsRecord,
            toolCallId,
            ctx: hookContext,
            signal,
          });
          if (outcome.blocked) {
            recorder?.discard?.(toolCallId, func.name);
            if (outcome.kind === "veto") {
              return buildBlockedToolResult({
                reason: outcome.reason,
                deniedReason: outcome.deniedReason,
                toolCallId,
                runId: hookContext?.runId,
              });
            }
            throw new Error(outcome.reason);
          }
          const paramsRecord = coerceParamsRecord(outcome.params, func.parameters);
          // Client-hosted tools have no tool-owned finalizer, so hook reconciliation
          // produces the canonical execution shape consumed here.
          const decision = control ? await control.pause(paramsRecord) : undefined;
          if (decision && !decision.launch) {
            recorder?.discard?.(toolCallId, func.name);
            return { content: [], details: { status: "skipped" } };
          }
          signal?.throwIfAborted();
          decision?.start?.();
          if (typeof onClientToolCall === "function") {
            onClientToolCall(func.name, paramsRecord);
          } else {
            recorder?.complete(toolCallId, func.name, paramsRecord);
          }
        } catch (err) {
          recorder?.discard?.(toolCallId, func.name);
          if (err instanceof ToolInputError) {
            return buildToolExecutionErrorResult({
              toolName: func.name,
              message: err.message,
            });
          }
          throw err;
        }
        // Return a terminal pending result; the client will execute the tool.
        return {
          ...jsonResult({
            status: "pending",
            tool: func.name,
            message: "Tool execution delegated to client",
          }),
          terminate: true,
        };
      },
    } satisfies ToolDefinition;
    return attachAdapterExecutionPreparer(definition);
  });
}
