/**
 * AI SDK v6 tool converter for openclaw.
 *
 * This module converts existing pi-agent tools to AI SDK format.
 * The conversion is done at runtime to avoid duplicating tool logic.
 *
 * Fork-friendly: uses existing pi-tools without modification.
 */

import { tool } from "ai";
import { jsonSchema } from "ai";
import { logDebug } from "../../logger.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isPlainObject } from "../../utils.js";
import type { AnyAgentTool } from "../pi-tools.types.js";

/**
 * Context passed to tool execution.
 * Mirrors the pi-agent tool context for compatibility.
 */
export interface ToolExecutionContext {
  /** Session key for the current agent session */
  sessionKey?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Current message ID */
  messageId?: string;
}

/**
 * Result from tool execution.
 */
export interface ToolResult {
  /** Human-readable title/summary */
  title?: string;
  /** Full output text */
  output: string;
  /** Metadata about the execution */
  metadata?: Record<string, unknown>;
  /** Whether output was truncated */
  truncated?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Convert a TypeBox schema to JSON Schema format.
 * TypeBox schemas are already JSON Schema compatible.
 */
function typeBoxToJsonSchema(schema: unknown): Record<string, unknown> {
  // TypeBox schemas are already JSON Schema compatible
  // Just ensure it's a valid object and return it
  if (typeof schema === "object" && schema !== null) {
    const s = schema as Record<string, unknown>;
    return {
      type: s.type ?? "object",
      properties: s.properties ?? {},
      required: s.required ?? [],
      description: s.description,
    };
  }
  return { type: "object", properties: {} };
}

/**
 * Extract text content from AgentToolResult.
 */
function extractTextFromToolResult(result: {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}): string {
  if (!result.content || !Array.isArray(result.content)) {
    return JSON.stringify(result.details ?? result);
  }
  const textParts = result.content
    .filter(
      (c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text);
  return textParts.join("\n") || JSON.stringify(result.details ?? {});
}

/** AI SDK tool type alias for converted tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConvertedAiSdkTool = ReturnType<typeof tool<any, any>>;

/**
 * Convert a single pi-agent tool to AI SDK format.
 *
 * @param piTool - The pi-agent tool to convert
 * @param context - Execution context for the tool
 * @returns AI SDK compatible tool
 */
export function convertPiToolToAiSdk(
  piTool: AnyAgentTool,
  context: ToolExecutionContext,
): ConvertedAiSdkTool {
  // Pi-agent tools have `parameters` (TypeBox schema)
  const schema = typeBoxToJsonSchema(piTool.parameters);

  const toolName = piTool.name ?? "tool";

  return tool({
    description: piTool.description ?? `Tool: ${toolName}`,
    inputSchema: jsonSchema(schema),
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const started = Date.now();
      const toolCallId = `aisdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = { toolName };

      // --- before_tool_call hook ---
      let executeArgs = args;
      if (hookRunner?.hasHooks("before_tool_call")) {
        try {
          const hookResult = await hookRunner.runBeforeToolCall(
            { toolName, params: isPlainObject(args) ? args : {} },
            hookCtx,
          );
          // syntheticResult takes precedence over block (doc: docs/plugins/agent-tools.md)
          if (hookResult?.syntheticResult !== undefined) {
            const syntheticOutput =
              typeof hookResult.syntheticResult === "string"
                ? hookResult.syntheticResult
                : JSON.stringify(hookResult.syntheticResult);
            if (hookRunner.hasHooks("after_tool_call")) {
              hookRunner
                .runAfterToolCall(
                  { toolName, params: args, result: hookResult.syntheticResult, durationMs: 0 },
                  hookCtx,
                )
                .catch((err) => {
                  logDebug(
                    `after_tool_call hook failed (synthetic path): ${toolName}: ${String(err)}`,
                  );
                });
            }
            return { output: syntheticOutput };
          }
          if (hookResult?.block) {
            const reason = hookResult.blockReason ?? "Tool call blocked by plugin hook";
            if (hookRunner.hasHooks("after_tool_call")) {
              hookRunner
                .runAfterToolCall({ toolName, params: args, error: reason, durationMs: 0 }, hookCtx)
                .catch((err) => {
                  logDebug(`after_tool_call hook failed (block path): ${toolName}: ${String(err)}`);
                });
            }
            return { output: `Error: ${reason}`, error: reason };
          }
          if (hookResult?.params && isPlainObject(hookResult.params)) {
            executeArgs = isPlainObject(args)
              ? { ...args, ...hookResult.params }
              : hookResult.params;
          }
        } catch (err) {
          logDebug(`before_tool_call hook error: ${toolName}: ${String(err)}`);
          // Hook errors must not break tool execution
        }
      }

      // --- actual tool execution ---
      try {
        const result = await piTool.execute(
          toolCallId,
          executeArgs,
          context.abortSignal,
          undefined,
        );

        // --- after_tool_call hook ---
        if (hookRunner?.hasHooks("after_tool_call")) {
          hookRunner
            .runAfterToolCall(
              { toolName, params: executeArgs, result, durationMs: Date.now() - started },
              hookCtx,
            )
            .catch((err) => {
              logDebug(`after_tool_call hook failed (success path): ${toolName}: ${String(err)}`);
            });
        }

        const output = extractTextFromToolResult(result);
        return {
          output,
          metadata: result.details as Record<string, unknown> | undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // --- after_tool_call hook (error path) ---
        if (hookRunner?.hasHooks("after_tool_call")) {
          hookRunner
            .runAfterToolCall(
              { toolName, params: executeArgs, error: message, durationMs: Date.now() - started },
              hookCtx,
            )
            .catch((err) => {
              logDebug(`after_tool_call hook failed (error path): ${toolName}: ${String(err)}`);
            });
        }

        return {
          output: `Error: ${message}`,
          error: message,
        };
      }
    },
  });
}

/**
 * Convert multiple pi-agent tools to AI SDK format.
 *
 * @param piTools - Array of pi-agent tools to convert
 * @param context - Execution context for the tools
 * @returns Record of tool name to AI SDK tool
 */
export function convertPiToolsToAiSdk(
  piTools: AnyAgentTool[],
  context: ToolExecutionContext,
): Record<string, ConvertedAiSdkTool> {
  const result: Record<string, ConvertedAiSdkTool> = {};

  for (const piTool of piTools) {
    if (!piTool.name) {
      continue;
    }
    result[piTool.name] = convertPiToolToAiSdk(piTool, context);
  }

  return result;
}

/**
 * Create AI SDK tools from openclaw's tool creation function.
 *
 * This is the main entry point for tool creation in the AI SDK engine.
 * It reuses the existing createOpenClawCodingTools() function and converts
 * the result to AI SDK format.
 *
 * @param options - Options passed to createOpenClawCodingTools
 * @param context - Execution context for the tools
 * @returns Record of tool name to AI SDK tool
 */
export async function createAiSdkTools(
  options: Parameters<typeof import("../pi-tools.js").createOpenClawCodingTools>[0],
  context: ToolExecutionContext,
): Promise<Record<string, ConvertedAiSdkTool>> {
  // Dynamically import to avoid circular dependencies
  const { createOpenClawCodingTools } = await import("../pi-tools.js");

  // Create pi-agent tools using existing function
  const piTools = createOpenClawCodingTools(options);

  // Convert to AI SDK format
  return convertPiToolsToAiSdk(piTools, context);
}
