import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logError, logWarn } from "../logger.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
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

const DEFAULT_TOOL_CALL_TIMEOUT_SECONDS = 60;

/**
 * Resolves the per-tool-call timeout in milliseconds from config.
 * Returns 0 if explicitly disabled, or the configured value (default: 60 seconds).
 */
function resolveToolCallTimeoutMs(cfg?: OpenClawConfig): number {
  const configuredSeconds = cfg?.agents?.defaults?.toolCallTimeoutSeconds;
  if (configuredSeconds === 0) {
    return 0; // Explicitly disabled
  }
  if (typeof configuredSeconds === "number" && configuredSeconds > 0) {
    return Math.floor(configuredSeconds * 1000);
  }
  return DEFAULT_TOOL_CALL_TIMEOUT_SECONDS * 1000;
}

/**
 * Wraps a tool execution promise with a timeout.
 * If the tool call exceeds the timeout, returns an error result.
 * Respects the signal's abort state and propagates abort errors.
 */
async function withToolCallTimeout<T>(params: {
  toolName: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  execute: () => Promise<T>;
}): Promise<T> {
  const { toolName, timeoutMs, signal, execute } = params;

  // If timeout is disabled (0), just execute directly
  if (timeoutMs === 0) {
    return execute();
  }

  // If already aborted, throw immediately
  if (signal?.aborted) {
    throw new Error("Tool call aborted before execution");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (value: T | Error) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (value instanceof Error) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (settled) return;
      const timeoutSeconds = Math.floor(timeoutMs / 1000);
      logWarn(
        `[tools] ${toolName} exceeded timeout (${timeoutSeconds}s) - returning error to model`,
      );
      finish(
        new Error(
          `Tool call timed out after ${timeoutSeconds} seconds. The operation may still be running in the background.`,
        ),
      );
    }, timeoutMs);

    // Set up abort handler if signal provided
    const onAbort = () => {
      finish(new Error("Tool call aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Execute the tool
    execute()
      .then((result) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        finish(result);
      })
      .catch((error) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        finish(error);
      });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  config?: OpenClawConfig,
): ToolDefinition[] {
  const timeoutMs = resolveToolCallTimeoutMs(config);

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
        try {
          return await withToolCallTimeout({
            toolName: normalizedName,
            timeoutMs,
            signal,
            execute: () => tool.execute(toolCallId, params, signal, onUpdate),
          });
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
