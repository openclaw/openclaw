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
  isMcpToolNameDeclared,
  resolveToolServer,
  UNKNOWN_MCP_SERVER,
} from "../memory/session-sanitization/config.js";
import { processMcpToolResult } from "../memory/session-sanitization/service.js";
import type { ToolOutputSchema } from "../memory/session-sanitization/types.js";
import { isPlainObject } from "../utils.js";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import { abortEmbeddedPiRun } from "./pi-embedded.js";
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

function prependContextNoteToPassthroughResult(params: {
  rawResult: AgentToolResult<unknown>;
  contextNote: string;
}): AgentToolResult<unknown> {
  const note = params.contextNote.trim();
  if (!note) {
    return params.rawResult;
  }
  return {
    ...params.rawResult,
    content: [{ type: "text", text: note }, ...params.rawResult.content],
  };
}

function extractMcpSanitizationPayload(rawResult: AgentToolResult<unknown>): unknown {
  if ("details" in rawResult && rawResult.details !== undefined) {
    return rawResult.details;
  }
  const firstContent = Array.isArray(rawResult.content) ? rawResult.content[0] : undefined;
  if (firstContent && typeof firstContent === "object" && "text" in firstContent) {
    const text = (firstContent as { text?: unknown }).text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
  }
  return firstContent;
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

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isVariantRecord(value: unknown): value is Record<string, Record<string, string>> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => isStringRecord(v));
}

function isToolOutputSchema(value: unknown): value is ToolOutputSchema {
  if (!isPlainObject(value)) return false;
  const schema = value as Record<string, unknown>;
  if ("fields" in schema && schema.fields !== undefined && !isStringRecord(schema.fields)) {
    return false;
  }
  if (
    "discriminant" in schema &&
    schema.discriminant !== undefined &&
    typeof schema.discriminant !== "string"
  ) {
    return false;
  }
  if ("variants" in schema && schema.variants !== undefined && !isVariantRecord(schema.variants)) {
    return false;
  }
  return "fields" in schema || "variants" in schema;
}

function fieldTypeFromJsonSchema(schema: Record<string, unknown>): string | undefined {
  if ("const" in schema) {
    return `const:${String(schema.const)}`;
  }

  const rawType = schema.type;
  if (typeof rawType === "string") {
    return rawType === "integer" ? "number" : rawType;
  }
  if (Array.isArray(rawType)) {
    const types = rawType
      .filter((v): v is string => typeof v === "string")
      .map((v) => (v === "integer" ? "number" : v));
    return types.length > 0 ? types.join(" | ") : undefined;
  }
  return undefined;
}

function asOptionalType(typeStr: string): string {
  const parts = typeStr
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.includes("undefined") ? typeStr : `${typeStr} | undefined`;
}

function jsonObjectSchemaToToolOutputSchema(value: unknown): ToolOutputSchema | undefined {
  if (!isPlainObject(value)) return undefined;
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object" || !isPlainObject(schema.properties)) return undefined;
  const requiredSet = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : [],
  );

  const fields: Record<string, string> = {};
  for (const [field, descriptor] of Object.entries(schema.properties)) {
    const fieldSchema = isPlainObject(descriptor)
      ? (descriptor as Record<string, unknown>)
      : undefined;
    const baseType = fieldSchema ? (fieldTypeFromJsonSchema(fieldSchema) ?? "any") : "any";
    fields[field] = requiredSet.has(field) ? baseType : asOptionalType(baseType);
  }
  return Object.keys(fields).length > 0 ? { fields } : undefined;
}

function extractToolOutputSchema(def: ToolDefinition): ToolOutputSchema | undefined {
  const keys = [
    "toolSchema",
    "outputSchema",
    "output_schema",
    "resultSchema",
    "result_schema",
  ] as const;
  const obj = def as unknown;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (isToolOutputSchema(candidate)) return candidate;
    const converted = jsonObjectSchemaToToolOutputSchema(candidate);
    if (converted) return converted;
  }
  return undefined;
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
    // Gate: only tools explicitly declared by exact name in cfg.mcpServers are
    // confirmed MCP tools.  Prefix entries in the registry are for server-
    // resolution disambiguation only, not for MCP membership.  A native tool
    // whose name happens to share a prefix with a configured server entry must
    // never reach processMcpToolResult.
    if (!isMcpToolNameDeclared(params.cfg, def.name)) {
      return def;
    }
    const server = resolveToolServer(params.cfg, def.name);
    // UNKNOWN_MCP_SERVER means ambiguous or unresolved — do NOT skip.
    // Route through processMcpToolResult as untrusted so sanitization applies.
    // Fail-open here would silently bypass sanitization for ambiguous mappings.
    changed = true;
    const originalExecute = def.execute;
    const toolSchema = extractToolOutputSchema(def);
    return {
      ...def,
      execute: async (
        ...args: Parameters<ToolDefinition["execute"]>
      ): Promise<AgentToolResult<unknown>> => {
        const rawResult = await originalExecute(...args);
        const sanitizerInput = extractMcpSanitizationPayload(rawResult);
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
            rawResult: sanitizerInput,
            toolSchema,
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
            terminated: mcpResult.terminated ?? false,
          });
          if (mcpResult.terminated) {
            abortEmbeddedPiRun(params.sessionId);
          }
          return jsonResult({
            status: "error",
            tool: def.name,
            error: "MCP result blocked by sanitization",
            server,
            flags: mcpResult.flags,
            contextNote: mcpResult.contextNote,
          });
        }

        if (mcpResult.sandboxSkip) {
          return prependContextNoteToPassthroughResult({
            rawResult: rawResult as AgentToolResult<unknown>,
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
