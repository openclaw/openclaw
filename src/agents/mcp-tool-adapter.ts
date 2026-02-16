import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { logError } from "../logger.js";
import { isPlainObject } from "../utils.js";
import type { McpToolHandle } from "./mcp-client.js";
import { jsonResult } from "./tools/common.js";

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

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, signal] = args;
    return { toolCallId, params, signal };
  }

  const [toolCallId, params, _onUpdate, _ctx, signal] = args;
  return { toolCallId, params, signal };
}

function resolveToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }
  return schema;
}

function describeToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message?.trim() ? error.message : String(error);
  }
  return String(error);
}

export function toMcpToolDefinitions(
  tools: McpToolHandle[],
  opts?: { timeoutMs?: number },
): ToolDefinition[] {
  return tools.map((tool) => {
    const description = tool.description?.trim()
      ? tool.description
      : `MCP tool from server \"${tool.serverName}\"`;

    return {
      name: tool.name,
      label: tool.name,
      description,
      // oxlint-disable-next-line typescript/no-explicit-any
      parameters: resolveToolParameters(tool.inputSchema) as any,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { params, signal } = splitToolExecuteArgs(args);
        const callArgs = isPlainObject(params) ? params : {};

        try {
          const result = await tool.call(callArgs, {
            timeoutMs: opts?.timeoutMs,
            signal,
          });
          return jsonResult(result);
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }

          const message = describeToolError(error);
          logError(`[tools] ${tool.name} (mcp:${tool.serverName}) failed: ${message}`);

          return jsonResult({
            status: "error",
            tool: tool.name,
            server: tool.serverName,
            error: message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}
