import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import { logDebug, logError } from "../logger.js";
import { isPlainObject } from "../utils.js";
import {
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
  runAfterToolCallHook,
  runBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

// oxlint-disable-next-line typescript/no-explicit-any
type AnyAgentTool = AgentTool<any, unknown>;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fourth = args[3];
  return isAbortSignal(third) || typeof fourth === "function";
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, signal, onUpdate] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, onUpdate, _ctx, signal] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        const hookToolCallId =
          typeof toolCallId === "string" && toolCallId.trim() ? toolCallId : `hook-${randomUUID()}`;
        const startedAt = Date.now();
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId: hookToolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }
          const result = await tool.execute(hookToolCallId, executeParams, signal, onUpdate);
          const afterParams = beforeHookWrapped
            ? (consumeAdjustedParamsForToolCall(hookToolCallId) ?? executeParams)
            : executeParams;
          await runAfterToolCallHook({
            toolName: name,
            params: afterParams,
            result,
            durationMs: Date.now() - startedAt,
            toolCallId: hookToolCallId,
          });
          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const name =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (name === "AbortError") {
            throw err;
          }
          const afterParams = beforeHookWrapped
            ? (consumeAdjustedParamsForToolCall(hookToolCallId) ?? executeParams)
            : executeParams;
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          const errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
          await runAfterToolCallHook({
            toolName: name,
            params: afterParams,
            error: described.message,
            durationMs: Date.now() - startedAt,
            toolCallId: hookToolCallId,
          });
          return errorResult;
        }
      },
    } satisfies ToolDefinition;
  });
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (
    toolName: string,
    params: Record<string, unknown>,
    toolCallId: string,
  ) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      // oxlint-disable-next-line typescript/no-explicit-any
      parameters: func.parameters as any,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        const hookToolCallId =
          typeof toolCallId === "string" && toolCallId.trim() ? toolCallId : `hook-${randomUUID()}`;
        const startedAt = Date.now();
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId: hookToolCallId,
          ctx: {
            ...hookContext,
            toolCallId: hookToolCallId,
          },
        });
        if (outcome.blocked) {
          await runAfterToolCallHook({
            toolName: func.name,
            params,
            error: outcome.reason,
            durationMs: Date.now() - startedAt,
            toolCallId: hookToolCallId,
            ctx: {
              ...hookContext,
              toolCallId: hookToolCallId,
            },
          });
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        let result: AgentToolResult<unknown> | undefined;
        let error: string | undefined;
        try {
          // Notify handler that a client tool was called
          if (onClientToolCall) {
            onClientToolCall(func.name, paramsRecord, hookToolCallId);
          }
          // Return a pending result - the client will execute this tool
          result = jsonResult({
            status: "pending",
            tool: func.name,
            toolCallId: hookToolCallId,
            message: "Tool execution delegated to client",
          });
          return result;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          await runAfterToolCallHook({
            toolName: func.name,
            params: adjustedParams,
            result,
            error,
            durationMs: Date.now() - startedAt,
            toolCallId: hookToolCallId,
            ctx: {
              ...hookContext,
              toolCallId: hookToolCallId,
            },
          });
        }
      },
    } satisfies ToolDefinition;
  });
}
