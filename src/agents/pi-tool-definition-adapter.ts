import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { logDebug } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import {
  consumeAdjustedParamsForToolCall,
  isToolWrappedWithBeforeToolCallHook,
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
    const message = sanitizeToolErrorMessage(err.message?.trim() ? err.message : String(err));
    return { message, stack: err.stack };
  }
  return { message: sanitizeToolErrorMessage(String(err)) };
}

function sanitizeToolErrorMessage(message: string): string {
  let text = typeof message === "string" ? message : String(message ?? "");
  text = text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
  text = text.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
  text = text.replace(/\]0;[^\r\n]*/g, "");
  text = text.replace(/\[(?:\?[\d;]+[hl]|(?:\d{1,3}(?:;\d{1,3})*)?[A-Za-z])/g, "");
  text = text.replace(/\x1B/g, "").replace(/\x07/g, "");
  return text.trim();
}

function normalizeToolExecuteParams(toolName: string, params: unknown): unknown {
  if (process.platform !== "win32") {
    return params;
  }
  if (toolName !== "exec") {
    return params;
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  const paramsRecord = params as Record<string, unknown>;
  const command = typeof paramsRecord.command === "string" ? paramsRecord.command : "";
  const trimmed = command.trimStart().toLowerCase();
  if (trimmed.startsWith("cmd ")) {
    return params;
  }
  const needsCmdShim = command.includes("&&") || command.includes("||");
  if (!needsCmdShim) {
    return params;
  }
  const escaped = command.replaceAll("\"", "\\\"");
  return {
    ...paramsRecord,
    command: `cmd /d /s /c "${escaped}"`,
  };
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
        let executeParams = normalizeToolExecuteParams(normalizedName, params);
        try {
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = normalizeToolExecuteParams(normalizedName, hookOutcome.params);
          }
          const result = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          const afterParams = beforeHookWrapped
            ? (consumeAdjustedParamsForToolCall(toolCallId) ?? executeParams)
            : executeParams;

          // Call after_tool_call hook
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: name,
                  params: isPlainObject(afterParams) ? afterParams : {},
                  result,
                },
                { toolName: name },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

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
          if (beforeHookWrapped) {
            consumeAdjustedParamsForToolCall(toolCallId);
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logDebug(`[tools] ${normalizedName} failed: ${described.message}`);

          const errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });

          // Call after_tool_call hook for errors too
          const hookRunner = getGlobalHookRunner();
          if (hookRunner?.hasHooks("after_tool_call")) {
            try {
              await hookRunner.runAfterToolCall(
                {
                  toolName: normalizedName,
                  params: isPlainObject(params) ? params : {},
                  error: described.message,
                },
                { toolName: normalizedName },
              );
            } catch (hookErr) {
              logDebug(
                `after_tool_call hook failed: tool=${normalizedName} error=${String(hookErr)}`,
              );
            }
          }

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
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: { agentId?: string; sessionKey?: string },
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
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }
        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};
        // Notify handler that a client tool was called
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }
        // Return a pending result - the client will execute this tool
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
