import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logError } from "../logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveToolServer,
  UNKNOWN_MCP_SERVER,
} from "../memory/session-sanitization/config.js";
import { processMcpToolResult } from "../memory/session-sanitization/service.js";
import { isPlainObject } from "../utils.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";

const mcpLog = createSubsystemLogger("agents/mcp-tool-wrap");

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
  AbortSignal | undefined,
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
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
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

function stringifyToolPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    const encoded = JSON.stringify(payload, null, 2);
    if (typeof encoded === "string") {
      return encoded;
    }
  } catch {
    // Fall through to String(payload) for non-serializable values.
  }
  return String(payload);
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
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return {
      content: [
        {
          type: "text",
          text: stringifyToolPayload(safeDetails),
        },
      ],
      details: safeDetails,
    };
  }
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return {
    content: [
      {
        type: "text",
        text: stringifyToolPayload(safeDetails),
      },
    ],
    details: safeDetails,
  };
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
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
        let executeParams = params;
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
            executeParams = hookOutcome.params;
          }
          const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          const result = normalizeToolExecutionResult({
            toolName: normalizedName,
            result: rawResult,
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

/**
 * Re-wrap any ToolDefinition whose name is claimed by a server in
 * `cfg.mcpServers` so that its `execute()` passes the raw result through
 * `processMcpToolResult` before returning to the agent session.
 *
 * - Definitions not claimed by any server are returned unchanged.
 * - If `safe: false`, a structured error block is returned so the manager
 *   sees a clear signal rather than raw adversarial content.
 * - If `safe: true`, the sanitized structuredResult is returned as text.
 * - When MCP sanitization is not enabled or no servers are declared, the
 *   array is returned as-is (zero allocation path).
 */
export function wrapMcpToolDefinitions(
  defs: ToolDefinition[],
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionId: string;
    lane?: string;
  },
): ToolDefinition[] {
  const registry = params.cfg.mcpServers;
  if (!registry || typeof registry !== "object" || Object.keys(registry).length === 0) {
    return defs;
  }

  let changed = false;
  const next = defs.map((def) => {
    const server = resolveToolServer(params.cfg, def.name);
    // Only wrap tools declared in mcpServers.  Tools whose names do not appear
    // in any server entry are native OpenClaw or client tools — they must not
    // be routed through processMcpToolResult.  The "unknown" sentinel means
    // "not an MCP tool in this context", not "untrusted MCP tool".
    if (server === UNKNOWN_MCP_SERVER) {
      return def;
    }
    changed = true;
    const originalExecute = def.execute;
    return {
      ...def,
      execute: async (
        ...args: Parameters<ToolDefinition["execute"]>
      ): Promise<AgentToolResult<unknown>> => {
        const rawResult = await originalExecute(...args);
        // args[0] is always the toolCallId regardless of legacy/current arg order.
        const toolCallId = typeof args[0] === "string" ? args[0] : "unknown";
        // args[1] is always the params object.
        const toolParams = args[1] ?? {};
        let mcpResult;
        try {
          mcpResult = await processMcpToolResult({
            cfg: params.cfg,
            agentId: params.agentId,
            sessionId: params.sessionId,
            server,
            toolCallId,
            toolName: def.name,
            rawResult,
            query: { server, tool: def.name, params: toolParams },
            helperDeps: { lane: params.lane ?? "background:session-memory-mcp" },
          });
        } catch (err) {
          mcpLog.warn("processMcpToolResult threw — failing closed", {
            server,
            tool: def.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return jsonResult({
            status: "error",
            tool: def.name,
            error: "MCP result blocked: sanitization helper failed",
            server,
          });
        }

        if (!mcpResult.safe) {
          mcpLog.warn("MCP result blocked by sanitization", {
            server,
            tool: def.name,
            tier: mcpResult.tier,
            flags: mcpResult.flags,
          });
          return jsonResult({
            status: "error",
            tool: def.name,
            error: "MCP result blocked by sanitization",
            server,
            flags: mcpResult.flags,
            contextNote: mcpResult.contextNote,
          });
        }

        if (mcpResult.trusted) {
          return rawResult as AgentToolResult<unknown>;
        }

        return jsonResult(
          Object.keys(mcpResult.structuredResult).length > 0
            ? mcpResult.structuredResult
            : { status: "ok", tool: def.name, contextNote: mcpResult.contextNote },
        );
      },
    } satisfies ToolDefinition;
  });

  return changed ? next : defs;
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
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
