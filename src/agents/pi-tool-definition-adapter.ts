import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { logDebug, logError, logWarn } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

// oxlint-disable-next-line typescript/no-explicit-any
type AnyAgentTool = AgentTool<any, unknown>;

export type ToolDefinitionHookContext = {
  agentId?: string;
  sessionKey?: string;
};

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

export function toToolDefinitions(
  tools: AnyAgentTool[],
  hookCtx?: ToolDefinitionHookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        const startMs = Date.now();
        let effectiveParams = params;

        // Run before_tool_call plugin hooks — may modify params or block execution.
        const hookRunner = getGlobalHookRunner();
        if (hookRunner?.hasHooks("before_tool_call")) {
          try {
            const hookResult = await hookRunner.runBeforeToolCall(
              { toolName: normalizedName, params: params as Record<string, unknown> },
              {
                agentId: hookCtx?.agentId,
                sessionKey: hookCtx?.sessionKey,
                toolName: normalizedName,
              },
            );
            if (hookResult?.block) {
              const reason = hookResult.blockReason ?? "Blocked by plugin hook";
              logWarn(`[tools] ${normalizedName} blocked by before_tool_call hook: ${reason}`);
              return jsonResult({ status: "blocked", tool: normalizedName, error: reason });
            }
            if (hookResult?.params) {
              effectiveParams = hookResult.params;
            }
          } catch (hookErr) {
            logWarn(
              `[tools] before_tool_call hook error for ${normalizedName}: ${String(hookErr)}`,
            );
          }
        }

        try {
          const result = await tool.execute(toolCallId, effectiveParams, signal, onUpdate);

          // Fire after_tool_call hooks (best-effort, non-blocking).
          if (hookRunner?.hasHooks("after_tool_call")) {
            const durationMs = Date.now() - startMs;
            hookRunner
              .runAfterToolCall(
                {
                  toolName: normalizedName,
                  params: effectiveParams as Record<string, unknown>,
                  result: result?.details,
                  durationMs,
                },
                {
                  agentId: hookCtx?.agentId,
                  sessionKey: hookCtx?.sessionKey,
                  toolName: normalizedName,
                },
              )
              .catch((err) =>
                logWarn(`[tools] after_tool_call hook error for ${normalizedName}: ${String(err)}`),
              );
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
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          // Fire after_tool_call hooks on error path too.
          if (hookRunner?.hasHooks("after_tool_call")) {
            const durationMs = Date.now() - startMs;
            hookRunner
              .runAfterToolCall(
                {
                  toolName: normalizedName,
                  params: effectiveParams as Record<string, unknown>,
                  error: described.message,
                  durationMs,
                },
                {
                  agentId: hookCtx?.agentId,
                  sessionKey: hookCtx?.sessionKey,
                  toolName: normalizedName,
                },
              )
              .catch((e) =>
                logWarn(`[tools] after_tool_call hook error for ${normalizedName}: ${String(e)}`),
              );
          }

          return jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
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
