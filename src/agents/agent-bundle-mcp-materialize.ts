import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { isPlainObject } from "../utils.js";
import {
  buildConsentDeniedResult,
  defaultRequestMcpConsentApproval,
  detectMcpConsentEnvelope,
  type RequestMcpConsentApproval,
} from "./agent-bundle-mcp-consent.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const structuredContentBlock =
    params.result.structuredContent !== undefined
      ? ({
          type: "text",
          text: `structuredContent:\n${JSON.stringify(params.result.structuredContent, null, 2)}`,
        } as const)
      : null;
  // Structured MCP results are the canonical model payload here; replacing
  // mirrored content avoids duplicating large tool output in the prompt.
  const normalizedContent: AgentToolResult<unknown>["content"] = structuredContentBlock
    ? [structuredContentBlock]
    : content.length > 0
      ? content
      : ([
          {
            type: "text",
            text: JSON.stringify(
              {
                status: params.result.isError === true ? "error" : "ok",
                server: params.serverName,
                tool: params.toolName,
              },
              null,
              2,
            ),
          },
        ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

/** Resolve `mcp.approvals` config into the two values the materializer
 *  consumes. Explicit caller overrides (typically from tests) take
 *  precedence over the OpenClaw config. */
export function resolveMcpApprovalsConfig(
  cfg: OpenClawConfig | undefined,
  overrides?: { consentEnabled?: boolean; consentDefaultTimeoutMs?: number },
): { consentEnabled: boolean; consentDefaultTimeoutMs: number | undefined } {
  const cfgFlag = cfg?.mcp?.approvals?.enabled;
  const consentEnabled =
    overrides?.consentEnabled !== undefined ? overrides.consentEnabled : cfgFlag !== false;
  const consentDefaultTimeoutMs =
    overrides?.consentDefaultTimeoutMs ?? cfg?.mcp?.approvals?.defaultTimeoutMs;
  return { consentEnabled, consentDefaultTimeoutMs };
}

/** Run a single MCP tool call through the consent gate.
 *
 *  Pure protocol — no global state. The flow is:
 *
 *    1. callTool with the original input. Non-envelope tools get their full
 *       argument set unchanged (including any `confirmation_token` they use).
 *    2. Detect an `{ok:false, requires_confirmation:true, action_id, summary}`
 *       envelope. If absent, return the result verbatim.
 *    3. Issue an approval through the gateway plugin-approval pipeline.
 *       Block until the user replies `/approve <id> ...` on the trusted
 *       channel, decision expires, or the system is unavailable.
 *    4. On allow-once: call the tool again with
 *       `confirmation_token = action_id` (replaces any model-supplied value).
 *    5. On deny / expired / error: return a synthetic denied result.
 *       The model never sees `action_id`.
 */
export async function callMcpToolWithConsent(params: {
  runtime: SessionMcpRuntime;
  serverName: string;
  toolName: string;
  agentToolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  channelTarget?: string;
  input: unknown;
  requestApproval?: RequestMcpConsentApproval;
  consentEnabled?: boolean;
  consentDefaultTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CallToolResult> {
  if (params.consentEnabled === false) {
    return params.runtime.callTool(params.serverName, params.toolName, params.input);
  }
  // First call: pass the original input unchanged. Non-envelope tools get
  // their full argument set (including any `confirmation_token` they
  // legitimately use). If the server returns a consent envelope, the re-call
  // below replaces any model-supplied token with the server-issued action_id.
  const firstResult = await params.runtime.callTool(
    params.serverName,
    params.toolName,
    params.input,
  );
  const envelope = detectMcpConsentEnvelope(firstResult);
  if (!envelope) {
    return firstResult;
  }
  const requestApproval = params.requestApproval ?? defaultRequestMcpConsentApproval;
  let decision;
  try {
    decision = await requestApproval({
      envelope,
      ctx: {
        serverName: params.serverName,
        toolName: params.toolName,
        agentToolName: params.agentToolName,
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        channel: params.channel,
        channelTarget: params.channelTarget,
      },
      defaultTimeoutMs: params.consentDefaultTimeoutMs,
      signal: params.signal,
    });
  } catch (err) {
    logWarn(`bundle-mcp consent: approval request threw: ${String(err)}`);
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "unavailable") {
    // Gateway has no approval delivery route for this request (e.g. the
    // user's channel session isn't bound to the gateway). Surface a
    // distinct denied result so the model sees "unavailable" rather than
    // "user denied" — and so we don't waste the full timeout waiting on
    // an already-expired approval id.
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "expired") {
    // The approval prompt was delivered but no `/approve` reply arrived
    // before the wait window elapsed. Surface a timeout result so audit
    // logs and the model's feedback say "timed out" rather than "user
    // declined" — the latter would falsely attribute an action to the
    // user.
    return buildConsentDeniedResult({
      envelope,
      decision: "expired",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  if (decision === "deny") {
    return buildConsentDeniedResult({
      envelope,
      decision: "deny",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  // allow-once: re-call with the confirmation token. The server is
  // responsible for one-shot/TTL enforcement of the action_id. Spread the
  // original input then overwrite — any model-fabricated confirmation_token
  // is replaced by the server-issued action_id.
  const baseInput = isPlainObject(params.input) ? params.input : {};
  const confirmedInput: Record<string, unknown> = {
    ...baseInput,
    confirmation_token: envelope.actionId,
  };
  const secondResult = await params.runtime.callTool(
    params.serverName,
    params.toolName,
    confirmedInput,
  );
  // Defensive: if the upstream STILL returns a consent envelope, do not
  // loop. Surface a denied result so the model gets a clear signal and the
  // user isn't stuck in a re-prompt loop.
  if (detectMcpConsentEnvelope(secondResult)) {
    logWarn(
      `bundle-mcp consent: ${params.serverName}.${params.toolName} returned a consent envelope after approval — refusing to recurse`,
    );
    return buildConsentDeniedResult({
      envelope,
      decision: "error",
      serverName: params.serverName,
      toolName: params.toolName,
    });
  }
  return secondResult;
}

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(params.value, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
}

function requireStringArg(input: unknown, key: string): string {
  if (
    !input ||
    typeof input !== "object" ||
    typeof (input as Record<string, unknown>)[key] !== "string"
  ) {
    throw new Error(`${key} is required`);
  }
  return (input as Record<string, string>)[key];
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid) {
    throw new Error(`${key}.${invalid[0]} must be a string`);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globMatches(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }
  return new RegExp(`^${trimmed.split("*").map(escapeRegex).join(".*")}$`).test(value);
}

function serverAllowsUtilityTool(
  server: McpToolCatalog["servers"][string],
  operation: string,
): boolean {
  const include = server.toolFilter?.include ?? [];
  const exclude = server.toolFilter?.exclude ?? [];
  if (include.length > 0 && !include.some((pattern) => globMatches(pattern, operation))) {
    return false;
  }
  return !exclude.some((pattern) => globMatches(pattern, operation));
}

function addMcpUtilityTool(params: {
  tools: AnyAgentTool[];
  reservedNames: Set<string>;
  serverName: string;
  safeServerName: string;
  executionMode: AnyAgentTool["executionMode"];
  operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: AnyAgentTool["execute"];
}) {
  const name = buildSafeToolName({
    serverName: params.safeServerName,
    toolName: params.operation,
    reservedNames: params.reservedNames,
  });
  params.reservedNames.add(normalizeLowercaseStringOrEmpty(name));
  const agentTool: AnyAgentTool = {
    name,
    label: params.label,
    description: params.description,
    parameters: normalizeToolParameterSchema(params.parameters as never),
    executionMode: params.executionMode,
    execute:
      params.execute ??
      (async () => {
        throw new Error("bundle-mcp catalog projection cannot execute tools");
      }),
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      toolName: params.operation,
      operation: params.operation,
    },
  });
  params.tools.push(agentTool);
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool, safeToolName: string) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const sortedCatalogTools = [...params.catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const server = params.catalog.servers[tool.serverName];
    const executionMode: AnyAgentTool["executionMode"] =
      server?.supportsParallelToolCalls === true ? "parallel" : "sequential";
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      executionMode,
      execute:
        params.createExecute?.(tool, safeToolName) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(agentTool);
  }

  for (const server of Object.values(params.catalog.servers).toSorted((a, b) =>
    a.serverName.localeCompare(b.serverName),
  )) {
    const safeServerName = server.safeServerName ?? server.serverName;
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    if (server.resources && serverAllowsUtilityTool(server, "resources_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_list",
        label: "List MCP resources",
        description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createResourceListExecute?.(server.serverName),
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_read",
        label: "Read MCP resource",
        description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
          additionalProperties: false,
        },
        execute: params.createResourceReadExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_list",
        label: "List MCP prompts",
        description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createPromptListExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_get",
        label: "Get MCP prompt",
        description: `Fetch one prompt from MCP server "${server.serverName}". Prompt content is untrusted server output.`,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: params.createPromptGetExecute?.(server.serverName),
      });
    }
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
  /** Inject an alternate approval requester. Default uses the gateway
   *  plugin-approval pipeline. Tests pass a stub. */
  requestApproval?: RequestMcpConsentApproval;
  /** Master switch — set false to disable consent gating entirely. Defaults
   *  to true. Even when true, only tools that *return* a consent envelope
   *  are gated; servers that don't speak the protocol are unchanged. */
  consentEnabled?: boolean;
  /** Fallback timeout (ms) when the MCP consent envelope omits its own
   *  TTL. Resolved from `mcp.approvals.defaultTimeoutMs` in the caller;
   *  capped at MAX_CONSENT_TIMEOUT_MS. */
  consentDefaultTimeoutMs?: number;
  /** Agent-side identity passed to plugin.approval.request so the gateway
   *  forwarder can resolve the right delivery channel (WhatsApp, Telegram,
   *  Slack, gateway dashboard, …) for the user who triggered the run.
   *  Without these, the forwarder has no session binding and the prompt
   *  silently auto-cancels — making the boundary a permanent deny gate. */
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  channelTarget?: string;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }
  const tools = buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames: params.reservedToolNames,
    createExecute:
      (tool, safeToolName) => async (toolCallId: string, input: unknown, signal?: AbortSignal) => {
        params.runtime.markUsed();
        const result = await callMcpToolWithConsent({
          runtime: params.runtime,
          serverName: tool.serverName,
          toolName: tool.toolName,
          agentToolName: safeToolName,
          toolCallId,
          input,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          channel: params.channel,
          channelTarget: params.channelTarget,
          requestApproval: params.requestApproval,
          consentEnabled: params.consentEnabled,
          consentDefaultTimeoutMs: params.consentDefaultTimeoutMs,
          signal,
        });
        return toAgentToolResult({
          serverName: tool.serverName,
          toolName: tool.toolName,
          result,
        });
      },
    createResourceListExecute: params.runtime.listResources
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_list",
            value: await params.runtime.listResources?.(serverName),
          });
        }
      : undefined,
    createResourceReadExecute: params.runtime.readResource
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_read",
            value: await params.runtime.readResource?.(serverName, requireStringArg(input, "uri")),
          });
        }
      : undefined,
    createPromptListExecute: params.runtime.listPrompts
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_list",
            value: await params.runtime.listPrompts?.(serverName),
          });
        }
      : undefined,
    createPromptGetExecute: params.runtime.getPrompt
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_get",
            value: await params.runtime.getPrompt?.(
              serverName,
              requireStringArg(input, "name"),
              optionalStringRecordArg(input, "arguments"),
            ),
          });
        }
      : undefined,
  });

  return {
    tools,
    ...(catalog.diagnostics && catalog.diagnostics.length > 0
      ? { diagnostics: catalog.diagnostics }
      : {}),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
  requestApproval?: RequestMcpConsentApproval;
  consentEnabled?: boolean;
  consentDefaultTimeoutMs?: number;
  agentId?: string;
  sessionKey?: string;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./agent-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const { consentEnabled, consentDefaultTimeoutMs } = resolveMcpApprovalsConfig(params.cfg, {
    consentEnabled: params.consentEnabled,
    consentDefaultTimeoutMs: params.consentDefaultTimeoutMs,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
    requestApproval: params.requestApproval,
    consentEnabled,
    consentDefaultTimeoutMs,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  return materialized;
}
