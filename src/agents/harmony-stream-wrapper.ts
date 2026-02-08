/**
 * Harmony stream wrapper for gpt-oss on Ollama.
 *
 * Problem: Ollama's Harmony parser cannot reverse-map tool calls from gpt-oss
 * back to OpenAI format. Every tool call is silently dropped, regardless of name.
 *
 * Solution: Bypass Ollama's Harmony parser entirely by:
 *  1. NOT sending tools in the API `tools` field
 *  2. Injecting tool definitions into the system prompt as plain text
 *  3. Parsing tool calls from the model's text output
 *  4. Emitting synthetic toolcall events so the agent loop dispatches them
 *
 * Conversation history handling:
 *  - AssistantMessage ToolCall blocks → converted to text with markers
 *  - ToolResultMessage → converted to user messages with result text
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Tool,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { logDebug, logWarn } from "../logger.js";
import { isGptOssOnOllama } from "./pi-tools.policy.js";

// Delimiters for text-mode tool calling.
// The model is instructed (via system prompt) to wrap tool calls in these markers.
const TOOL_CALL_START = "<tool_call>";
const TOOL_CALL_END = "</tool_call>";

// ---------------------------------------------------------------------------
// System prompt: tool definitions in plain text
// ---------------------------------------------------------------------------

function describeToolParameters(tool: Tool): string {
  // oxlint-disable-next-line typescript/no-explicit-any
  const schema = tool.parameters as any;
  if (!schema?.properties || typeof schema.properties !== "object") {
    return "  (no parameters)";
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties)
    .map(([name, prop]) => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const p = prop as any;
      const req = required.includes(name) ? "required" : "optional";
      const desc = p.description ? ` — ${p.description}` : "";
      const type = p.type ?? "any";
      return `  - ${name} (${type}, ${req})${desc}`;
    })
    .join("\n");
}

function generateToolExample(tool: Tool): string {
  // oxlint-disable-next-line typescript/no-explicit-any
  const schema = tool.parameters as any;
  if (!schema?.properties || typeof schema.properties !== "object") {
    return `${TOOL_CALL_START}\n{"name": "${tool.name}", "arguments": {}}\n${TOOL_CALL_END}`;
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const example: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const p = prop as any;
    // Only include required params in the example
    if (!required.includes(name)) {
      continue;
    }
    if (p.type === "string") {
      example[name] = p.description ? `<${name}>` : "value";
    } else if (p.type === "number" || p.type === "integer") {
      example[name] = 0;
    } else if (p.type === "boolean") {
      example[name] = true;
    } else {
      example[name] = `<${name}>`;
    }
  }
  return `${TOOL_CALL_START}\n${JSON.stringify({ name: tool.name, arguments: example })}\n${TOOL_CALL_END}`;
}

function generateToolPrompt(tools: Tool[]): string {
  if (tools.length === 0) {
    return "";
  }

  const defs = tools
    .map(
      (t) =>
        `### ${t.name}\n${t.description ?? "(no description)"}\nParameters:\n${describeToolParameters(t)}\nExample:\n${generateToolExample(t)}`,
    )
    .join("\n\n");

  return [
    "",
    "# Available Tools",
    "",
    "To call a tool, output the call in this EXACT format:",
    "",
    `${TOOL_CALL_START}`,
    `{"name": "TOOL_NAME", "arguments": {"param1": "value1"}}`,
    `${TOOL_CALL_END}`,
    "",
    "CRITICAL RULES:",
    "- The `arguments` value must be a flat JSON object with the tool's parameters as direct keys.",
    '- Do NOT nest `{"name": ..., "arguments": ...}` inside `arguments`. That is WRONG.',
    "- All parameter values must match their declared type. Strings must be strings, not arrays.",
    "- Always include ALL required parameters.",
    "- Use ONLY the tool names listed below (exact spelling).",
    "- Output ONE tool call at a time, then STOP and wait for the result.",
    "- The result will appear in the next message. Use it to decide your next step.",
    "- Do NOT invent tool names that are not listed.",
    "",
    "## Tool Definitions",
    "",
    defs,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Message conversion: ToolCall / ToolResult → text
// ---------------------------------------------------------------------------

function convertMessagesForTextMode(messages: Message[]): Message[] {
  const converted = messages.flatMap((msg): Message[] => {
    if (msg.role === "assistant") {
      const hasToolCalls = msg.content.some((c) => c.type === "toolCall");
      if (!hasToolCalls) {
        return [msg];
      }
      // Convert tool call blocks to text markers so the model can see the history
      const parts = msg.content
        .map((block) => {
          if (block.type === "text") {
            return block.text;
          }
          if (block.type === "toolCall") {
            const tc = block as ToolCall;
            return `${TOOL_CALL_START}\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n${TOOL_CALL_END}`;
          }
          // Skip thinking blocks — they're internal
          return "";
        })
        .filter(Boolean);
      return [
        {
          ...msg,
          content: [{ type: "text" as const, text: parts.join("\n") }],
        },
      ];
    }

    if (msg.role === "toolResult") {
      const textParts = msg.content.map((c) => (c.type === "text" ? c.text : "[non-text content]"));
      return [
        {
          role: "user" as const,
          content: `[Tool Result for "${msg.toolName}"]:\n${textParts.join("\n")}`,
          timestamp: msg.timestamp,
        },
      ];
    }

    return [msg];
  });

  // Merge consecutive user messages to avoid role-ordering rejections
  return mergeConsecutiveUserMessages(converted);
}

function mergeConsecutiveUserMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (msg.role === "user" && prev?.role === "user") {
      const prevText = typeof prev.content === "string" ? prev.content : "";
      const curText = typeof msg.content === "string" ? msg.content : "";
      result[result.length - 1] = {
        role: "user",
        content: `${prevText}\n\n${curText}`,
        timestamp: msg.timestamp,
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Response parsing: extract tool calls from text
// ---------------------------------------------------------------------------

function parseToolCallsFromText(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let pos = 0;

  while (pos < text.length) {
    const start = text.indexOf(TOOL_CALL_START, pos);
    if (start < 0) {
      break;
    }
    const end = text.indexOf(TOOL_CALL_END, start);
    if (end < 0) {
      break;
    }

    const raw = text.slice(start + TOOL_CALL_START.length, end).trim();
    try {
      const parsed = JSON.parse(raw) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name && typeof parsed.name === "string") {
        // Unwrap double-wrapped arguments: if `parsed.arguments` itself has
        // a `{name, arguments}` structure, extract the inner `arguments`.
        let args: Record<string, unknown> = parsed.arguments ?? {};
        if (
          typeof args === "object" &&
          "name" in args &&
          "arguments" in args &&
          typeof args.arguments === "object" &&
          args.arguments !== null
        ) {
          args = args.arguments as Record<string, unknown>;
        }
        // Fix array values that should be strings (e.g. command: ["bash","-lc","ls"])
        // by joining them into a single string.
        for (const [key, val] of Object.entries(args)) {
          if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
            args[key] = (val as string[]).join(" ");
          }
        }
        calls.push({
          name: parsed.name,
          arguments: args,
        });
      }
    } catch {
      logWarn(`harmony-wrapper: Could not parse tool call JSON: ${raw.slice(0, 200)}`);
    }

    pos = end + TOOL_CALL_END.length;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

async function pipeAndParseToolCalls(
  input: AssistantMessageEventStream,
  output: AssistantMessageEventStream,
): Promise<void> {
  let fullText = "";

  try {
    for await (const event of input) {
      // Accumulate text for post-hoc tool call detection
      if (event.type === "text_delta") {
        fullText += event.delta;
      }

      // Everything except "done" is passed through unchanged.
      // This means the user sees streaming text (including <tool_call> markers).
      if (event.type !== "done") {
        output.push(event);
        continue;
      }

      // "done" — check accumulated text for tool calls.
      const toolCalls = parseToolCallsFromText(fullText);

      if (toolCalls.length === 0) {
        // No tool calls found → pass through as-is.
        output.push(event);
        continue;
      }

      logDebug(
        `harmony-wrapper: Detected ${toolCalls.length} tool call(s) in text: ${toolCalls.map((tc) => tc.name).join(", ")}`,
      );

      // Build a modified AssistantMessage that contains real ToolCall blocks
      // instead of text with markers.
      const originalMessage = event.message;

      // Separate text before the first marker from the rest.
      const firstMarkerPos = fullText.indexOf(TOOL_CALL_START);
      const textBefore = firstMarkerPos > 0 ? fullText.slice(0, firstMarkerPos).trim() : "";

      // Keep non-text content blocks (e.g. thinking) from the original message.
      const nonTextBlocks = originalMessage.content.filter((b) => b.type !== "text");

      const toolCallBlocks: ToolCall[] = toolCalls.map((tc, i) => ({
        type: "toolCall" as const,
        id: `harmony-tc-${Date.now()}-${i}`,
        name: tc.name,
        arguments: tc.arguments as Record<string, never>,
      }));

      const modifiedContent = [
        ...nonTextBlocks,
        ...(textBefore ? [{ type: "text" as const, text: textBefore }] : []),
        ...toolCallBlocks,
      ];

      const modifiedMessage: AssistantMessage = {
        ...originalMessage,
        content: modifiedContent,
        stopReason: "toolUse",
      };

      // Emit synthetic toolcall events so the agent loop picks them up.
      const textBlockCount = modifiedContent.filter(
        (b) => b.type === "text" || b.type === "thinking",
      ).length;
      for (let i = 0; i < toolCallBlocks.length; i++) {
        const idx = textBlockCount + i;
        const tc = toolCallBlocks[i];
        output.push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: modifiedMessage,
        });
        output.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: JSON.stringify(tc.arguments),
          partial: modifiedMessage,
        });
        output.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: tc,
          partial: modifiedMessage,
        });
      }

      // Final "done" with toolUse stop reason.
      output.push({
        type: "done",
        reason: "toolUse",
        message: modifiedMessage,
      });
    }
  } catch (err) {
    const errorMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "ollama",
      model: "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    };
    output.push({ type: "error", reason: "error", error: errorMessage });
  }
}

/**
 * Creates a StreamFn wrapper that bypasses Ollama's broken Harmony parser
 * for gpt-oss models.
 *
 * Returns `null` when the model is not gpt-oss on Ollama (no wrapping needed).
 */
export function createGptOssHarmonyWrapper(params: {
  modelProvider?: string;
  modelId?: string;
}): ((streamFn: StreamFn) => StreamFn) | null {
  if (!isGptOssOnOllama(params)) {
    return null;
  }

  logDebug(
    `harmony-wrapper: Will bypass Ollama Harmony parser for ${params.modelProvider}/${params.modelId}`,
  );

  return (streamFn: StreamFn): StreamFn => {
    const wrapped: StreamFn = (model, context, options) => {
      const tools = context.tools ?? [];

      if (tools.length === 0) {
        // No tools → nothing to bypass, call through directly.
        return streamFn(model, context, options);
      }

      logDebug(
        `harmony-wrapper: Intercepting request — moving ${tools.length} tool(s) from API to system prompt`,
      );

      // 1. Build modified context: no API tools, tool defs in system prompt,
      //    tool history converted to text.
      const modifiedContext: Context = {
        systemPrompt: (context.systemPrompt ?? "") + generateToolPrompt(tools),
        messages: convertMessagesForTextMode(context.messages),
        // Omit tools → Ollama won't activate Harmony tool-call parsing.
      };

      // 2. Call the real streamFn (may return sync or async).
      const streamResult = streamFn(model, modifiedContext, options);

      // 3. Create wrapped output stream.
      const wrappedStream = createAssistantMessageEventStream();

      // Handle both sync (AssistantMessageEventStream) and async (Promise<…>) return.
      const attach = async () => {
        const originalStream = await streamResult;
        await pipeAndParseToolCalls(originalStream, wrappedStream);
      };

      attach().catch((err) => {
        logWarn(`harmony-wrapper: stream processing error: ${err}`);
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        wrappedStream.push({ type: "error", reason: "error", error: errorMessage });
      });

      return wrappedStream;
    };

    return wrapped;
  };
}
