import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginHookToolContext } from "../plugins/types.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { logDebug, logError } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isPlainObject } from "../utils.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

// oxlint-disable-next-line typescript/no-explicit-any
type AnyAgentTool = AgentTool<any, unknown>;

export type ToolHookOptions = {
  context: ToolHookContext;
  getMessages: () => AgentMessage[];
  systemPrompt?: string;
};

export type ToolHookContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  provider: string;
  modelId: string;
  workspaceDir: string;
  messageProvider?: string;
  messageChannel?: string;
  config?: OpenClawConfig;
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

type ClientToolHookOptions = {
  guardrails?: ToolHookOptions;
  agentId?: string;
  sessionKey?: string;
};

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
  options?: { guardrails?: ToolHookOptions },
): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const hookOptions = options?.guardrails;
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        const hookRunner = getGlobalHookRunner();
        let effectiveParams = params;

        // Build tool context for hooks
        const toolContext: PluginHookToolContext | undefined = hookOptions
          ? {
              agentId: hookOptions.context.agentId,
              sessionKey: hookOptions.context.sessionKey,
              sessionId: hookOptions.context.sessionId,
              runId: hookOptions.context.runId,
              provider: hookOptions.context.provider,
              modelId: hookOptions.context.modelId,
              workspaceDir: hookOptions.context.workspaceDir,
              messageProvider: hookOptions.context.messageProvider,
              messageChannel: hookOptions.context.messageChannel,
              config: hookOptions.context.config,
              toolName: normalizedName,
            }
          : undefined;

        // Run before_tool_call hooks
        if (hookRunner?.hasHooks("before_tool_call") && hookOptions && toolContext) {
          const safeToolCallId = toolCallId ?? `unknown-${Date.now()}`;
          const hookResult = await hookRunner.runBeforeToolCall(
            {
              toolName: normalizedName,
              toolCallId: String(safeToolCallId),
              params: effectiveParams as Record<string, unknown>,
              messages: hookOptions.getMessages(),
              systemPrompt: hookOptions.systemPrompt,
            },
            toolContext,
          );
          if (hookResult?.block) {
            return (
              hookResult.toolResult ??
              jsonResult({
                status: "blocked",
                tool: normalizedName,
                message: hookResult.blockReason ?? "Tool call blocked by policy.",
              })
            );
          }
          if (hookResult?.params) {
            effectiveParams = hookResult.params;
          }
        }

        try {
          let result = await tool.execute(toolCallId, effectiveParams, signal, onUpdate);

          // Run after_tool_call hooks
          if (hookRunner?.hasHooks("after_tool_call") && hookOptions && toolContext) {
            const safeToolCallId = toolCallId ?? `unknown-${Date.now()}`;
            const hookResult = await hookRunner.runAfterToolCall(
              {
                toolName: normalizedName,
                toolCallId: String(safeToolCallId),
                params: effectiveParams as Record<string, unknown>,
                result,
                messages: hookOptions.getMessages(),
                systemPrompt: hookOptions.systemPrompt,
              },
              toolContext,
            );
            if (hookResult?.block) {
              return (
                hookResult.result ??
                jsonResult({
                  status: "blocked",
                  tool: normalizedName,
                  message: hookResult.blockReason ?? "Tool result blocked by policy.",
                })
              );
            }
            if (hookResult?.result) {
              result = hookResult.result;
            }
          }

          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          const errName =
            err && typeof err === "object" && "name" in err
              ? String((err as { name?: unknown }).name)
              : "";
          if (errName === "AbortError") {
            throw err;
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          logError(`[tools] ${normalizedName} failed: ${described.message}`);
          let errorResult = jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });

          // Run after_tool_call hooks even for errors
          if (hookRunner?.hasHooks("after_tool_call") && hookOptions && toolContext) {
            const safeToolCallId = toolCallId ?? `unknown-${Date.now()}`;
            const hookResult = await hookRunner.runAfterToolCall(
              {
                toolName: normalizedName,
                toolCallId: String(safeToolCallId),
                params: effectiveParams as Record<string, unknown>,
                result: errorResult,
                messages: hookOptions.getMessages(),
                systemPrompt: hookOptions.systemPrompt,
              },
              toolContext,
            );
            if (hookResult?.block) {
              return (
                hookResult.result ??
                jsonResult({
                  status: "blocked",
                  tool: normalizedName,
                  message: hookResult.blockReason ?? "Tool result blocked by policy.",
                })
              );
            }
            if (hookResult?.result) {
              errorResult = hookResult.result;
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
  options?: ClientToolHookOptions,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    const normalizedName = normalizeToolName(func.name);
    const hookOptions = options?.guardrails;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      // oxlint-disable-next-line typescript/no-explicit-any
      parameters: func.parameters as any,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        const hookRunner = getGlobalHookRunner();
        let effectiveParams = params;

        // Build tool context for guardrail hooks
        const toolContext: PluginHookToolContext | undefined = hookOptions
          ? {
              agentId: hookOptions.context.agentId,
              sessionKey: hookOptions.context.sessionKey,
              sessionId: hookOptions.context.sessionId,
              runId: hookOptions.context.runId,
              provider: hookOptions.context.provider,
              modelId: hookOptions.context.modelId,
              workspaceDir: hookOptions.context.workspaceDir,
              messageProvider: hookOptions.context.messageProvider,
              messageChannel: hookOptions.context.messageChannel,
              config: hookOptions.context.config,
              toolName: normalizedName,
            }
          : undefined;

        if (hookOptions) {
          // Run before_tool_call guardrail hooks
          if (hookRunner?.hasHooks("before_tool_call") && toolContext) {
            const safeToolCallId = toolCallId ?? `unknown-${Date.now()}`;
            const hookResult = await hookRunner.runBeforeToolCall(
              {
                toolName: normalizedName,
                toolCallId: String(safeToolCallId),
                params: effectiveParams as Record<string, unknown>,
                messages: hookOptions.getMessages(),
                systemPrompt: hookOptions.systemPrompt,
              },
              toolContext,
            );
            if (hookResult?.block) {
              return (
                hookResult.toolResult ??
                jsonResult({
                  status: "blocked",
                  tool: normalizedName,
                  message: hookResult.blockReason ?? "Tool call blocked by policy.",
                })
              );
            }
            if (hookResult?.params) {
              effectiveParams = hookResult.params;
            }
          }
        } else {
          const outcome = await runBeforeToolCallHook({
            toolName: func.name,
            params,
            toolCallId,
            ctx: options ? { agentId: options.agentId, sessionKey: options.sessionKey } : undefined,
          });
          if (outcome.blocked) {
            throw new Error(outcome.reason);
          }
          effectiveParams = outcome.params;
        }

        const paramsRecord = isPlainObject(effectiveParams) ? effectiveParams : {};
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }

        // Return a pending result - the client will execute this tool
        let result = jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });

        // Run after_tool_call hooks
        if (hookRunner?.hasHooks("after_tool_call") && hookOptions && toolContext) {
          const safeToolCallId = toolCallId ?? `unknown-${Date.now()}`;
          const hookResult = await hookRunner.runAfterToolCall(
            {
              toolName: normalizedName,
              toolCallId: String(safeToolCallId),
              params: effectiveParams as Record<string, unknown>,
              result,
              messages: hookOptions.getMessages(),
              systemPrompt: hookOptions.systemPrompt,
            },
            toolContext,
          );
          if (hookResult?.block) {
            return (
              hookResult.result ??
              jsonResult({
                status: "blocked",
                tool: normalizedName,
                message: hookResult.blockReason ?? "Tool result blocked by policy.",
              })
            );
          }
          if (hookResult?.result) {
            result = hookResult.result;
          }
        }

        return result;
      },
    } satisfies ToolDefinition;
  });
}
