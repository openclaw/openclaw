/**
 * Streaming voice response generator.
 * Calls the Anthropic Messages API directly with stream:true,
 * detects sentence boundaries, and emits text chunks for TTS.
 * Supports tool_use for calendar booking and other function calls.
 */

import type { VoiceCallConfig } from "./config.js";

const SENTENCE_ENDINGS = /[.!?]/;
const MAX_BUFFER_CHARS = 100; // Flush at comma/space after this many chars

/** Tool definition in Anthropic API format. */
export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** Callback to execute a tool and return the result as a string. */
export type ToolExecutor = (toolName: string, input: Record<string, unknown>) => Promise<string>;

export type StreamingResponseParams = {
  voiceConfig: VoiceCallConfig;
  apiKey: string;
  baseUrl?: string;
  from: string;
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  userMessage: string;
  /** Called for each sentence-sized chunk as it's ready */
  onSentence: (text: string) => void;
  /** Called when the full response is done */
  onDone: (fullText: string) => void;
  /** Called on error */
  onError: (error: Error) => void;
  timeoutMs?: number;
  /** External abort signal for barge-in cancellation */
  signal?: AbortSignal;
  /** Override the model from voiceConfig (used for escalation routing) */
  modelOverride?: string;
  /** Tool definitions to pass to the Anthropic API */
  tools?: ToolDefinition[];
  /** Executor for tool calls — required if tools are provided */
  toolExecutor?: ToolExecutor;
};

/** Detect if buffer contains a sentence boundary worth flushing. */
function findFlushPoint(buffer: string): number {
  // Look for sentence-ending punctuation followed by a space or end of string
  for (let i = 0; i < buffer.length; i++) {
    if (SENTENCE_ENDINGS.test(buffer[i]!)) {
      // Check if next char is space, end of string, or quote
      const next = buffer[i + 1];
      if (!next || next === " " || next === '"' || next === "'") {
        return i + 1;
      }
    }
  }

  // If buffer is getting long, flush at next comma or space
  if (buffer.length >= MAX_BUFFER_CHARS) {
    // Try comma first
    for (let i = MAX_BUFFER_CHARS - 20; i < buffer.length; i++) {
      if (buffer[i] === ",") return i + 1;
    }
    // Then space
    for (let i = MAX_BUFFER_CHARS - 10; i < buffer.length; i++) {
      if (buffer[i] === " ") return i;
    }
  }

  return -1;
}

/** Accumulated state for a tool_use block during streaming. */
type PendingToolUse = {
  id: string;
  name: string;
  inputJson: string; // Accumulated partial JSON from input_json_delta events
};

export async function streamVoiceResponse(params: StreamingResponseParams): Promise<void> {
  const {
    voiceConfig,
    apiKey,
    baseUrl = "https://api.anthropic.com",
    from,
    transcript,
    userMessage,
    onSentence,
    onDone,
    onError,
    timeoutMs = 15000,
    signal: externalSignal,
    tools,
    toolExecutor,
  } = params;

  // Build messages array from transcript
  const messages: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (const entry of transcript) {
    messages.push({
      role: entry.speaker === "user" ? "user" : "assistant",
      content: entry.text,
    });
  }
  // Add current user message
  messages.push({ role: "user", content: userMessage });

  // Build system prompt (inject today's date for calendar scheduling)
  const today = new Date().toISOString().split("T")[0];
  const rawPrompt =
    voiceConfig.responseSystemPrompt ??
    `You are an AI receptionist on a phone call. Keep responses brief (1-2 sentences). Be natural and friendly. Caller: ${from}.`;
  const systemPrompt = `${rawPrompt}\n\nToday's date is ${today}.`;

  // Resolve model (escalation override takes priority)
  const modelRef = params.modelOverride || voiceConfig.responseModel || "claude-haiku-4-5-20251001";
  const model = modelRef.includes("/") ? modelRef.split("/")[1]! : modelRef;

  // Run the streaming call (may loop if tool_use is returned)
  await streamWithToolLoop({
    apiKey,
    baseUrl,
    model,
    systemPrompt,
    messages,
    tools,
    toolExecutor,
    onSentence,
    onDone,
    onError,
    timeoutMs,
    externalSignal,
  });
}

/** Internal: run the streaming API call, handling tool_use with a continuation loop. */
async function streamWithToolLoop(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: any }>;
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  onSentence: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}): Promise<void> {
  const {
    apiKey,
    baseUrl,
    model,
    systemPrompt,
    onSentence,
    onDone,
    onError,
    timeoutMs,
    externalSignal,
  } = opts;

  // Clone messages so we can append tool results without mutating the original
  const messages = [...opts.messages];
  const hasTools = opts.tools && opts.tools.length > 0;

  // Allow up to 3 rounds of tool use (check → book → confirm)
  const MAX_TOOL_ROUNDS = 3;
  let fullText = "";
  // Track if barge-in fired — we still complete tool execution but stop emitting text
  let bargedIn = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const controller = new AbortController();
    // Use longer timeout when tools are involved (tool execution adds latency)
    const roundTimeoutMs = hasTools ? Math.max(timeoutMs, 30000) : timeoutMs;
    const timeout = setTimeout(() => controller.abort(), roundTimeoutMs);

    // Wire external abort signal — but ONLY for aborting the HTTP stream read,
    // NOT for preventing tool execution. Once we detect tool_use in the stream,
    // we complete tool execution regardless of barge-in.
    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal && !bargedIn) {
      if (externalSignal.aborted) {
        bargedIn = true;
      } else {
        externalAbortHandler = () => {
          bargedIn = true;
          // Don't abort the controller here — let the stream finish reading
          // so we can detect tool_use blocks even during barge-in
        };
        externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
      }
    }

    try {
      const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");

      const body: Record<string, unknown> = {
        model,
        max_tokens: 1024,
        stream: true,
        system: systemPrompt,
        messages,
      };

      if (hasTools) {
        body.tools = opts.tools;
      }

      const response = await fetch(`${normalizedBase}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`Anthropic API error (${response.status}): ${errorBody.slice(0, 200)}`);
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
      }

      // Parse SSE stream
      let buffer = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      // Tool use tracking
      let pendingTool: PendingToolUse | null = null;
      const completedToolCalls: PendingToolUse[] = [];
      let stopReason = "";
      let roundText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);

            // Track stop reason
            if (event.type === "message_delta" && event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }

            // Text content — only emit sentences if not barged-in
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              const text = event.delta.text;
              buffer += text;
              fullText += text;
              roundText += text;

              if (!bargedIn) {
                let flushPoint = findFlushPoint(buffer);
                while (flushPoint > 0) {
                  const sentence = buffer.slice(0, flushPoint).trim();
                  if (sentence) {
                    onSentence(sentence);
                  }
                  buffer = buffer.slice(flushPoint).trimStart();
                  flushPoint = findFlushPoint(buffer);
                }
              }
            }

            // Tool use: content_block_start with type "tool_use"
            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              pendingTool = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: "",
              };
            }

            // Tool use: accumulate input JSON
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "input_json_delta" &&
              pendingTool
            ) {
              pendingTool.inputJson += event.delta.partial_json;
            }

            // Tool use: content_block_stop — finalize the tool call
            if (event.type === "content_block_stop" && pendingTool) {
              completedToolCalls.push({ ...pendingTool });
              pendingTool = null;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      // Flush remaining text buffer (only if not barged-in)
      if (!bargedIn) {
        const remaining = buffer.trim();
        if (remaining) {
          onSentence(remaining);
        }
      }

      clearTimeout(timeout);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }

      // If stop_reason is "tool_use", execute tools and continue — even if barged-in.
      // Tool execution is never cancelled by barge-in because the user expects
      // the booking/check to complete regardless of interruptions.
      if (stopReason === "tool_use" && completedToolCalls.length > 0 && opts.toolExecutor) {
        // Build the assistant message content (text + tool_use blocks)
        const assistantContent: any[] = [];
        if (roundText) {
          assistantContent.push({ type: "text", text: roundText });
        }
        for (const tc of completedToolCalls) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tc.inputJson || "{}");
          } catch {
            parsedInput = {};
          }
          assistantContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          });
        }

        // Add assistant message with tool_use to conversation
        messages.push({ role: "assistant", content: assistantContent });

        // Execute each tool and build tool_result messages
        const toolResults: any[] = [];
        for (const tc of completedToolCalls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.inputJson || "{}");
          } catch {
            /* empty */
          }

          const result = await opts.toolExecutor(tc.name, parsedInput);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: result,
          });
        }

        // Add tool results as user message
        messages.push({ role: "user", content: toolResults });

        // Reset text buffer for next round (keep fullText for transcript)
        buffer = "";

        // Continue loop — next iteration will stream the follow-up response
        continue;
      }

      // No tool use — we're done
      onDone(fullText);
      return;
    } catch (err) {
      clearTimeout(timeout);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
      if (err instanceof Error && err.name === "AbortError") {
        if (bargedIn) {
          onDone(fullText);
        } else {
          onError(new Error("Voice response timed out"));
        }
      } else {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
  }

  // If we exhaust tool rounds, finalize with what we have
  onDone(fullText);
}
