// Register OpenClaw's native tool inventory (TypeBox-based) on a
// Claude Agent SDK in-process MCP server so the model can call them
// through the SDK.
//
// Flow:
//   OpenClaw `createOpenClawCodingTools()` → `AnyAgentTool[]`
//       (TypeBox `parameters` + `execute(toolCallId, params, signal, onUpdate)`)
//   → per-tool TypeBox → Zod conversion via `typebox-to-zod.ts`
//   → register as an `SdkMcpToolDefinition` on `createSdkMcpServer()`
//   → pass the resulting `McpServerConfig` into `query({ options: { mcpServers } })`
//
// Tool policy: OpenClaw's `resolveEffectiveToolPolicy()` already filters
// the tool inventory before `createOpenClawCodingTools()` returns it. If
// a tool is in the array, it's already allow-listed for this run, so we
// don't need to duplicate the policy gate at `canUseTool` time. The SDK's
// `canUseTool` is still an option for finer per-call gating, but for
// Phase 2xB it stays as the simple "allow if registered" gate.
//
// Unsupported TypeBox shapes are logged (via `log.warn`) but don't fail
// registration — the tool is still registered with a best-effort Zod
// schema and the TypeBox-based validation inside `tool.execute()` catches
// any schema mismatch the model produces.

import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "./../tools/common.js";
import { createSubsystemLogger } from "./../../logging/subsystem.js";
import { convertTypeBoxObjectToZodShape } from "./typebox-to-zod.js";

const log = createSubsystemLogger("agents/claude-sdk/native-tools");

export type BuildOpenClawMcpServerParams = {
  /** OpenClaw's in-process tool inventory for this run. */
  tools: AnyAgentTool[];
  /** Optional server name (shown to the model in tool namespacing). */
  serverName?: string;
  /** Run identifier used as a correlation id when logging adapter issues. */
  runId?: string;
};

export type BuildOpenClawMcpServerResult = {
  /** Drop-in value for `options.mcpServers.openclaw` (or whatever name). */
  config: McpSdkServerConfigWithInstance;
  /** Name to use as the key in `options.mcpServers`. */
  name: string;
  /** How many of the input tools actually got registered. */
  registered: number;
  /** How many were skipped because their schema couldn't be converted. */
  skipped: number;
};

/**
 * Build an in-process MCP server that exposes OpenClaw's native tool
 * inventory to the Claude Agent SDK. Call once per run, after
 * `createOpenClawCodingTools()` has produced the policy-filtered tool
 * array, and pass the returned config into the SDK query options.
 */
export async function buildOpenClawMcpServer(
  params: BuildOpenClawMcpServerParams,
): Promise<BuildOpenClawMcpServerResult> {
  // Dynamic import: the SDK module is only loaded from inside the
  // claude-sdk code path (AGENTS.md dynamic-import guardrail).
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const serverName = params.serverName ?? "openclaw";
  let registered = 0;
  let skipped = 0;
  const sdkTools: Array<SdkMcpToolDefinition<Record<string, never>>> = [];

  for (const tool of params.tools) {
    const converted = convertTool({
      tool,
      runId: params.runId,
    });
    if (!converted) {
      skipped += 1;
      continue;
    }
    sdkTools.push(converted);
    registered += 1;
  }

  const config = sdk.createSdkMcpServer({
    name: serverName,
    tools: sdkTools,
  });

  if (skipped > 0) {
    log.warn(
      `[native-tools] runId=${params.runId ?? "<none>"} registered=${registered} skipped=${skipped} ` +
        `(tools with unconvertible schemas are still logged above)`,
    );
  }

  return { config, name: serverName, registered, skipped };
}

type ConvertToolParams = {
  tool: AnyAgentTool;
  runId?: string;
};

function convertTool(
  params: ConvertToolParams,
): SdkMcpToolDefinition<Record<string, never>> | null {
  const { tool, runId } = params;
  let shape: Record<string, unknown>;
  try {
    const result = convertTypeBoxObjectToZodShape(tool.parameters, {
      onUnsupported: (reason) => {
        log.warn(
          `[native-tools] tool=${tool.name} runId=${runId ?? "<none>"} ` +
            `unconvertible schema fragment: ${reason}`,
        );
      },
    });
    shape = result.shape;
  } catch (err) {
    log.warn(
      `[native-tools] tool=${tool.name} runId=${runId ?? "<none>"} ` +
        `skipping (top-level schema not convertible): ${(err as Error).message}`,
    );
    return null;
  }

  const handler = async (args: unknown): Promise<CallToolResult> => {
    const toolCallId = `claude-sdk-${Date.now()}-${tool.name}`;
    let params: unknown;
    try {
      params = tool.prepareArguments ? tool.prepareArguments(args) : args;
    } catch (err) {
      return {
        content: [{ type: "text", text: `Input validation failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(
        toolCallId,
        params as never,
        undefined, // abortSignal — the SDK manages its own abort at the query level
      );
      return agentResultToMcp(result);
    } catch (err) {
      return {
        content: [{ type: "text", text: (err as Error).message }],
        isError: true,
      };
    }
  };

  return {
    name: tool.name,
    description: tool.description,
    // We intentionally cast the shape: the SDK's generic expects a
    // specific Zod shape, but our converter produces a dynamic shape
    // per-tool. Any schema mismatch is caught by OpenClaw's own
    // TypeBox validation inside `tool.execute()`.
    inputSchema: shape as unknown as Record<string, never>,
    handler,
  };
}

type MaybeAgentToolResult = {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type?: string; [k: string]: unknown }
  >;
};

/**
 * Translate OpenClaw's `AgentToolResult` shape into the MCP
 * `CallToolResult` shape the SDK expects. `text` and `image` content
 * blocks share the same field names across both systems, so the
 * mapping is mostly a passthrough; unknown block types are dropped
 * with a safe empty-string fallback so the SDK never sees a malformed
 * content entry.
 */
function agentResultToMcp(raw: unknown): CallToolResult {
  const result = raw as MaybeAgentToolResult;
  const inputs = Array.isArray(result?.content) ? result.content : [];
  const out: CallToolResult["content"] = [];
  for (const block of inputs) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: string; [k: string]: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (
      b.type === "image" &&
      typeof b.data === "string" &&
      typeof b.mimeType === "string"
    ) {
      out.push({ type: "image", data: b.data, mimeType: b.mimeType });
    }
    // Other block types are dropped (the MCP shape has a smaller vocabulary).
  }
  return { content: out, isError: false };
}
