import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { projectMcpGetPromptResult, setMcpCodeModeGuestResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import type { AnyAgentTool } from "./tools/common.js";

type ServerExecute = (serverName: string) => AnyAgentTool["execute"];

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  const publicValue = toToolSearchJsonSafe(
    params.operation === "resources_list" && Array.isArray(params.value)
      ? { resources: params.value }
      : params.operation === "prompts_list" && Array.isArray(params.value)
        ? { prompts: params.value }
        : params.value,
  );
  if (isRecord(publicValue)) {
    delete publicValue._meta;
  }
  const result: AgentToolResult<unknown> = {
    content: [
      {
        type: "text",
        text: JSON.stringify(publicValue, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
  return setMcpCodeModeGuestResult(result, publicValue);
}

function requireStringArg(input: unknown, key: string): string {
  const value = isRecord(input) ? input[key] : undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  // SAFETY: `input` is a non-null object, checked just above; its values are read as unknown.
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

/**
 * Executors for an MCP runtime's resource and prompt utility tools. Each runs `assertRequesterCurrent` for its
 * server right before it uses the runtime's credentials.
 */
export function createMcpUtilityExecutors(
  runtime: SessionMcpRuntime,
  assertRequesterCurrent: (serverName: string) => void,
): {
  createResourceListExecute?: ServerExecute;
  createResourceReadExecute?: ServerExecute;
  createPromptListExecute?: ServerExecute;
  createPromptGetExecute?: ServerExecute;
} {
  const getPrompt = runtime.getPrompt?.bind(runtime);
  const createListExecute = (
    method: "listResources" | "listPrompts",
    operation: "resources_list" | "prompts_list",
  ): ServerExecute | undefined =>
    runtime[method]
      ? (serverName) => (_toolCallId, _input, signal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            assertRequesterCurrent(serverName);
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation,
              value: await runtime[method]?.(serverName),
            });
          })
      : undefined;
  return {
    createResourceListExecute: createListExecute("listResources", "resources_list"),
    createResourceReadExecute: runtime.readResource
      ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            const uri = requireStringArg(input, "uri");
            assertRequesterCurrent(serverName);
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation: "resources_read",
              value: await runtime.readResource?.(serverName, uri),
            });
          })
      : undefined,
    createPromptListExecute: createListExecute("listPrompts", "prompts_list"),
    createPromptGetExecute: getPrompt
      ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            assertRequesterCurrent(serverName);
            runtime.markUsed();
            return projectMcpGetPromptResult(
              await getPrompt(
                serverName,
                requireStringArg(input, "name"),
                optionalStringRecordArg(input, "arguments"),
              ),
              {
                mcpServer: serverName,
                mcpOperation: "prompts_get",
                untrustedMcpOutput: true,
              },
            );
          })
      : undefined,
  };
}
