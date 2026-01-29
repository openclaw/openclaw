/**
 * MiniMax Tool Executor
 *
 * Executes MiniMax's XML tool calls manually since the pi-agent-core library
 * doesn't recognize their proprietary format.
 *
 * Flow:
 * 1. Parse XML tool calls from assistant response
 * 2. Execute each tool using the provided tool definitions
 * 3. Format results
 * 4. Return formatted results for injection into conversation
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { emitAgentEvent } from "../infra/agent-events.js";
import {
  parseMinimaxToolCalls,
  hasCompleteMinimaxToolCall,
  generateMinimaxToolCallId,
  stripMinimaxToolCallBlocks,
  type MinimaxToolCall,
} from "./minimax-tool-parser.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/** Maximum number of tool execution loops to prevent infinite loops */
const MAX_TOOL_LOOPS = 10;

/** Maximum time to spend on a single tool execution (ms) */
const TOOL_EXECUTION_TIMEOUT_MS = 60_000;

export interface MinimaxToolExecutionResult {
  /** The tool call that was executed */
  toolCall: MinimaxToolCall;
  /** Tool call ID for correlation */
  toolCallId: string;
  /** Result from tool execution */
  result: unknown;
  /** Whether execution resulted in an error */
  isError: boolean;
  /** Error message if isError is true */
  errorMessage?: string;
  /** Execution duration in ms */
  durationMs: number;
}

export interface MinimaxExecutionLoopResult {
  /** All tool results from this loop iteration */
  results: MinimaxToolExecutionResult[];
  /** Formatted text to inject into conversation */
  formattedResults: string;
  /** Whether there are more tool calls to process */
  hasMoreToolCalls: boolean;
  /** Number of loop iterations completed */
  loopCount: number;
  /** Whether max loops was hit */
  maxLoopsReached: boolean;
}

/**
 * Find a tool by name in the tools array.
 */
function findTool(tools: AnyAgentTool[], name: string): AnyAgentTool | undefined {
  const normalized = name.trim().toLowerCase();
  return tools.find((t) => t.name.toLowerCase() === normalized);
}

/**
 * Execute a single MiniMax tool call.
 */
async function executeSingleTool(
  toolCall: MinimaxToolCall,
  tools: AnyAgentTool[],
  runId: string,
  abortSignal?: AbortSignal,
): Promise<MinimaxToolExecutionResult> {
  const toolCallId = generateMinimaxToolCallId();
  const startTime = Date.now();

  // Emit start event
  emitAgentEvent({
    runId,
    stream: "tool",
    data: {
      phase: "start",
      name: toolCall.name,
      toolCallId,
      source: "minimax-executor",
      arguments: Object.keys(toolCall.arguments),
    },
  });

  const tool = findTool(tools, toolCall.name);
  if (!tool) {
    const durationMs = Date.now() - startTime;
    emitAgentEvent({
      runId,
      stream: "tool",
      data: {
        phase: "end",
        name: toolCall.name,
        toolCallId,
        source: "minimax-executor",
        isError: true,
        errorMessage: `Tool not found: ${toolCall.name}`,
        durationMs,
      },
    });
    return {
      toolCall,
      toolCallId,
      result: null,
      isError: true,
      errorMessage: `Tool not found: ${toolCall.name}`,
      durationMs,
    };
  }

  try {
    // Create timeout abort controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), TOOL_EXECUTION_TIMEOUT_MS);

    // Combine with external abort signal
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, timeoutController.signal])
      : timeoutController.signal;

    const result = await tool.execute(toolCallId, toolCall.arguments, combinedSignal);
    clearTimeout(timeoutId);

    const durationMs = Date.now() - startTime;

    emitAgentEvent({
      runId,
      stream: "tool",
      data: {
        phase: "end",
        name: toolCall.name,
        toolCallId,
        source: "minimax-executor",
        isError: false,
        durationMs,
      },
    });

    return {
      toolCall,
      toolCallId,
      result,
      isError: false,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    emitAgentEvent({
      runId,
      stream: "tool",
      data: {
        phase: "end",
        name: toolCall.name,
        toolCallId,
        source: "minimax-executor",
        isError: true,
        errorMessage,
        durationMs,
      },
    });

    return {
      toolCall,
      toolCallId,
      result: null,
      isError: true,
      errorMessage,
      durationMs,
    };
  }
}

/**
 * Format tool results for injection into the conversation.
 * This creates a message that MiniMax can understand and continue from.
 */
function formatToolResults(results: MinimaxToolExecutionResult[]): string {
  if (results.length === 0) return "";

  const parts = results.map((r) => {
    const resultContent = r.isError
      ? `Error: ${r.errorMessage}`
      : typeof r.result === "string"
        ? r.result
        : JSON.stringify(r.result, null, 2);

    // Truncate very long results
    const maxLen = 50000;
    const truncated =
      resultContent.length > maxLen
        ? resultContent.slice(0, maxLen) + "\n...[truncated]"
        : resultContent;

    return `[Tool Result: ${r.toolCall.name}]\n${truncated}`;
  });

  return parts.join("\n\n---\n\n");
}

/**
 * Extract assistant text from a message.
 * @internal Currently unused but kept for future MiniMax enhancements
 */
function _getAssistantText(message: AgentMessage | undefined): string {
  if (!message || (message as { role?: string }).role !== "assistant") return "";
  const assistant = message as AssistantMessage;
  if (typeof assistant.content === "string") return assistant.content;
  if (Array.isArray(assistant.content)) {
    return assistant.content
      .filter(
        (c: { type: string; text?: string }): c is { type: "text"; text: string } =>
          c.type === "text" && typeof c.text === "string",
      )
      .map((c: { type: "text"; text: string }) => c.text)
      .join("");
  }
  return "";
}

/**
 * Execute all MiniMax tool calls found in the assistant's response.
 */
export async function executeMinimaxToolCalls(params: {
  /** Last assistant message text */
  assistantText: string;
  /** Available tools */
  tools: AnyAgentTool[];
  /** Run ID for event correlation */
  runId: string;
  /** Current loop iteration */
  loopCount: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}): Promise<MinimaxExecutionLoopResult> {
  const { assistantText, tools, runId, loopCount, abortSignal } = params;

  // Check for max loops
  if (loopCount >= MAX_TOOL_LOOPS) {
    emitAgentEvent({
      runId,
      stream: "minimax",
      data: {
        phase: "max_loops_reached",
        loopCount,
        maxLoops: MAX_TOOL_LOOPS,
      },
    });
    return {
      results: [],
      formattedResults: "",
      hasMoreToolCalls: false,
      loopCount,
      maxLoopsReached: true,
    };
  }

  // Parse tool calls from assistant text
  if (!hasCompleteMinimaxToolCall(assistantText)) {
    return {
      results: [],
      formattedResults: "",
      hasMoreToolCalls: false,
      loopCount,
      maxLoopsReached: false,
    };
  }

  const toolCalls = parseMinimaxToolCalls(assistantText);
  if (toolCalls.length === 0) {
    return {
      results: [],
      formattedResults: "",
      hasMoreToolCalls: false,
      loopCount,
      maxLoopsReached: false,
    };
  }

  emitAgentEvent({
    runId,
    stream: "minimax",
    data: {
      phase: "executing_tools",
      loopCount: loopCount + 1,
      toolCount: toolCalls.length,
      toolNames: toolCalls.map((t) => t.name),
    },
  });

  // Execute all tool calls
  const results: MinimaxToolExecutionResult[] = [];
  for (const toolCall of toolCalls) {
    if (abortSignal?.aborted) break;
    const result = await executeSingleTool(toolCall, tools, runId, abortSignal);
    results.push(result);
  }

  const formattedResults = formatToolResults(results);

  return {
    results,
    formattedResults,
    hasMoreToolCalls: true, // Assume more tool calls possible after injecting results
    loopCount: loopCount + 1,
    maxLoopsReached: false,
  };
}

/**
 * Check if text contains MiniMax XML tool calls.
 */
export function hasPendingMinimaxToolCalls(text: string): boolean {
  return hasCompleteMinimaxToolCall(text);
}

/**
 * Strip MiniMax tool calls from text for display purposes.
 */
export { stripMinimaxToolCallBlocks };
