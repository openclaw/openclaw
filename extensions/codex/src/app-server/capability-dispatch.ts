/** Owner-bound portable capability dispatcher for the live Codex MCP catalog. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexDynamicToolSpec, CodexMcpServerStatus, JsonObject } from "./protocol.js";

export const CODEX_CAPABILITY_DISPATCH_TOOL_NAME = "capability_dispatch";
type Adapter = "knowledge" | "hindsight";
type Input = {
  adapter: Adapter;
  operation: string;
  arguments?: JsonObject;
  authorization?: { scope: string; purpose: string };
};

const tools: Record<Adapter, Record<string, string | undefined>> = {
  knowledge: {
    read: "knowledge_read",
    search: "knowledge_search",
    create: "knowledge_create",
    update: "knowledge_update",
    append: "knowledge_append",
    commit: "knowledge_commit",
  },
  hindsight: { recall: "recall", retain: "sync_retain", reflect: "reflect", test_scope: undefined },
};
const mutating = new Set([
  "knowledge:create",
  "knowledge:update",
  "knowledge:append",
  "knowledge:commit",
  "hindsight:retain",
  "hindsight:reflect",
  "hindsight:test_scope",
]);

function failed(
  status: "unavailable" | "permission_denied",
  text: string,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `${status}: ${text}` }],
    details: { status },
    isError: true,
  };
}
function permission(error: unknown) {
  return /permission|forbidden|unauthori[sz]ed|access denied/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
function parse(value: unknown): Input | undefined {
  const record = asOptionalRecord(value);
  const adapter = normalizeOptionalString(record?.adapter);
  const operation = normalizeOptionalString(record?.operation);
  if ((adapter !== "knowledge" && adapter !== "hindsight") || !operation) return undefined;
  const auth = asOptionalRecord(record?.authorization);
  const scope = normalizeOptionalString(auth?.scope);
  const purpose = normalizeOptionalString(auth?.purpose);
  return {
    adapter,
    operation,
    ...(asOptionalRecord(record?.arguments)
      ? { arguments: asOptionalRecord(record?.arguments) as JsonObject }
      : {}),
    ...(scope && purpose ? { authorization: { scope, purpose } } : {}),
  };
}

export async function dispatchCodexCapability(params: {
  client: Pick<CodexAppServerClient, "request">;
  threadId: string;
  input: unknown;
}): Promise<AgentToolResult<unknown>> {
  const input = parse(params.input);
  if (!input) return failed("unavailable", "unsupported capability request");
  const tool = tools[input.adapter][input.operation];
  // test_scope has no fallback: a shared bank is never an isolated scope.
  if (!tool) return failed("unavailable", "operation is not available on an isolated adapter");
  if (mutating.has(`${input.adapter}:${input.operation}`) && !input.authorization) {
    return failed("permission_denied", "explicit authorization with scope and purpose is required");
  }
  let statuses: CodexMcpServerStatus[];
  try {
    statuses = (
      await params.client.request("mcpServerStatus/list", {
        threadId: params.threadId,
        detail: "full",
      })
    ).data;
  } catch (error) {
    return failed(
      permission(error) ? "permission_denied" : "unavailable",
      "MCP catalog unavailable",
    );
  }
  const matches = statuses.filter((entry) =>
    Object.prototype.hasOwnProperty.call(entry.tools, tool),
  );
  if (matches.length !== 1)
    return failed(
      "unavailable",
      matches.length ? "required MCP tool is ambiguous" : "required MCP tool is unavailable",
    );
  try {
    const response = await params.client.request("mcpServer/tool/call", {
      threadId: params.threadId,
      server: matches[0]!.name,
      tool,
      arguments: input.arguments ?? {},
    });
    const result = asOptionalRecord(response);
    if (!result || !Array.isArray(result.content))
      return failed("unavailable", "MCP tool returned an invalid response");
    return {
      content: result.content as AgentToolResult<unknown>["content"],
      ...(result.structuredContent !== undefined
        ? { details: { structuredContent: result.structuredContent } }
        : {}),
      ...(result.isError === true ? { isError: true } : {}),
    };
  } catch (error) {
    return failed(
      permission(error) ? "permission_denied" : "unavailable",
      "MCP capability call failed",
    );
  }
}

export function createCodexCapabilityDispatchTool(): AnyAgentTool {
  return {
    name: CODEX_CAPABILITY_DISPATCH_TOOL_NAME,
    description:
      "Call an enabled portable knowledge or memory capability through the active Codex MCP catalog. Mutations require authorization.scope and authorization.purpose.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["adapter", "operation"],
      properties: {
        adapter: { type: "string", enum: ["knowledge", "hindsight"] },
        operation: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
        authorization: {
          type: "object",
          additionalProperties: false,
          required: ["scope", "purpose"],
          properties: {
            scope: { type: "string", minLength: 1 },
            purpose: { type: "string", minLength: 1 },
          },
        },
      },
    },
    execute: async () => failed("unavailable", "active Codex runtime context is required"),
  } as AnyAgentTool;
}
export function createCodexCapabilityDispatchSpec(): CodexDynamicToolSpec {
  const tool = createCodexCapabilityDispatchTool();
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JsonObject,
  } as CodexDynamicToolSpec;
}
