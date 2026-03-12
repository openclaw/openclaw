import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall, Tool } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveMerlinTokenManager } from "../providers/merlin-auth.js";
import {
  buildAssistantMessage as buildStreamAssistantMessage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
} from "./stream-message-shared.js";

const log = createSubsystemLogger("merlin-stream");

const MERLIN_API_BASE = "https://www.getmerlin.in/arcane/api";

// ── Merlin request types ─────────────────────────────────────────────────────

interface MerlinChatRequest {
  attachments: unknown[];
  chatId: string;
  language: string;
  message: {
    id: string;
    childId: string;
    parentId: string;
    content: string;
    context: string;
  };
  mode: string;
  model: string;
  metadata: {
    noTask: boolean;
    isWebpageChat: boolean;
    deepResearch: boolean;
    webAccess: boolean;
    proFinderMode: boolean;
    mcpConfig: { isEnabled: boolean };
    merlinMagic: boolean;
  };
}

// ── SSE event types (confirmed via testing) ──────────────────────────────────

interface MerlinMessageEvent {
  data?: {
    content: string;
    index: number;
    type: "text" | "reasoning";
    text?: string;
    reasoning?: string;
  };
  status?: "system";
}

interface MerlinErrorEvent {
  message: string;
  type: string;
}

interface MerlinUsageEvent {
  cost?: {
    dailyUsage?: { usage: number; limit: number };
    monthlyUsage?: { usage: number; limit: number };
  };
  userPlan?: string;
}

// ── Tool-calling workaround ──────────────────────────────────────────────────
// Merlin doesn't support native function calling. We inject tool schemas into
// the system prompt and parse structured JSON responses.

const TOOL_CALL_INSTRUCTION = `
When you want to use a tool, respond with ONLY a JSON block in exactly this format (no other text before or after):
\`\`\`json
{"tool_calls": [{"name": "tool_name", "arguments": {"arg1": "value1"}}]}
\`\`\`

Available tools:
`;

function buildToolSystemPromptSuffix(tools: Tool[]): string {
  if (tools.length === 0) {
    return "";
  }

  const toolDescriptions = tools
    .map((tool) => {
      const params = tool.parameters ? JSON.stringify(tool.parameters) : "{}";
      return `- ${tool.name}: ${tool.description ?? "No description"}\n  Parameters: ${params}`;
    })
    .join("\n");

  return `${TOOL_CALL_INSTRUCTION}${toolDescriptions}`;
}

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function tryParseToolCalls(text: string): ParsedToolCall[] | undefined {
  // Only accept tool calls inside an explicit ```json fence, as instructed.
  const jsonBlockMatch = /```json\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
  if (!jsonBlockMatch) {
    return undefined;
  }
  const jsonText = jsonBlockMatch[1];

  try {
    const parsed = JSON.parse(jsonText) as { tool_calls?: ParsedToolCall[] };
    if (
      Array.isArray(parsed.tool_calls) &&
      parsed.tool_calls.length > 0 &&
      parsed.tool_calls.every(
        (tc: unknown) =>
          typeof tc === "object" &&
          tc !== null &&
          typeof (tc as ParsedToolCall).name === "string" &&
          typeof (tc as ParsedToolCall).arguments === "object",
      )
    ) {
      return parsed.tool_calls;
    }
  } catch {
    // Not a tool call response — that's fine.
  }
  return undefined;
}

// ── Message conversion ───────────────────────────────────────────────────────

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Flatten the pi-ai message history into a single Merlin prompt string.
 * Merlin's API is essentially a single-turn chat — we include conversation
 * history by formatting it into the message content.
 */
function buildMerlinContent(
  messages: Array<{ role: string; content: unknown }>,
  system: string | undefined,
  tools: Tool[] | undefined,
): string {
  const parts: string[] = [];

  if (system) {
    parts.push(system);
  }

  if (tools && tools.length > 0) {
    parts.push(buildToolSystemPromptSuffix(tools));
  }

  // Include conversation history so the model has context.
  for (const msg of messages) {
    const text = extractTextContent(msg.content);

    if (msg.role === "user") {
      if (text) {
        parts.push(`User: ${text}`);
      }
    } else if (msg.role === "assistant") {
      if (text) {
        parts.push(`Assistant: ${text}`);
      } else if (Array.isArray(msg.content)) {
        // Serialize tool-call turns so the model sees its own tool invocations.
        const toolCallSummaries = (msg.content as InputContentPart[])
          .filter((p) => p.type === "toolCall" || p.type === "tool_use")
          .map((p) => {
            const tc = p as { name: string; arguments?: unknown; input?: unknown };
            const args = JSON.stringify(tc.arguments ?? tc.input ?? {});
            return `[TOOL_CALL: ${tc.name}(${args})]`;
          })
          .join(", ");
        if (toolCallSummaries) {
          parts.push(`Assistant: ${toolCallSummaries}`);
        }
      }
    } else if (msg.role === "tool" || msg.role === "toolResult") {
      const toolName =
        typeof (msg as { toolName?: unknown }).toolName === "string"
          ? (msg as { toolName?: string }).toolName
          : "tool";
      parts.push(`Tool result (${toolName}): ${text}`);
    }
  }

  return parts.join("\n\n");
}

// ── SSE stream parser ────────────────────────────────────────────────────────

interface ParsedSseEvent {
  event: string;
  data: string;
}

export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      let eventName = currentEvent;
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventName = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        } else if (line === "data:") {
          data = "";
        }
      }

      if (eventName || data) {
        yield { event: eventName, data };
        currentEvent = "";
      }
    }
  }

  // Process any remaining buffer.
  if (buffer.trim()) {
    const lines = buffer.split("\n");
    let eventName = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }
    if (eventName || data) {
      yield { event: eventName, data };
    }
  }
}

// ── Main StreamFn factory ────────────────────────────────────────────────────

function buildTimestamp(): string {
  return new Date().toISOString().replace("Z", "+00:00[UTC]");
}

export function createMerlinStreamFn(): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const tokenManager = resolveMerlinTokenManager();
        if (!tokenManager) {
          throw new Error(
            "Merlin credentials not configured. Set MERLIN_EMAIL + MERLIN_PASSWORD or MERLIN_REFRESH_TOKEN.",
          );
        }

        const idToken = await tokenManager.getIdToken();

        const chatId = randomUUID();
        const msgId = randomUUID();
        const childId = randomUUID();
        const parentId = randomUUID();

        const content = buildMerlinContent(
          context.messages ?? [],
          context.systemPrompt,
          context.tools,
        );

        const body: MerlinChatRequest = {
          attachments: [],
          chatId,
          language: "AUTO",
          message: {
            id: msgId,
            childId,
            parentId,
            content,
            context: "",
          },
          mode: "UNIFIED_CHAT",
          model: model.id,
          metadata: {
            noTask: true,
            isWebpageChat: false,
            deepResearch: false,
            webAccess: false,
            proFinderMode: false,
            mcpConfig: { isEnabled: false },
            merlinMagic: false,
          },
        };

        const response = await fetch(`${MERLIN_API_BASE}/v2/thread/unified`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-merlin-version": "web-merlin",
            "x-request-timestamp": buildTimestamp(),
            ...options?.headers,
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Merlin API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Merlin API returned empty response body");
        }

        const reader = response.body.getReader();
        let accumulatedText = "";
        let accumulatedReasoning = "";
        let hadError = false;
        let errorMessage = "";

        for await (const sseEvent of parseSseStream(reader)) {
          if (sseEvent.event === "error") {
            hadError = true;
            try {
              const errData = JSON.parse(sseEvent.data) as MerlinErrorEvent;
              errorMessage = errData.message || "Unknown Merlin error";
            } catch {
              errorMessage = sseEvent.data || "Unknown Merlin error";
            }
            continue;
          }

          if (sseEvent.event === "message") {
            try {
              const msgData = JSON.parse(sseEvent.data) as MerlinMessageEvent;

              // Check for DONE signal.
              if (msgData.status === "system") {
                const eventType = (msgData.data as unknown as { eventType?: string })?.eventType;
                if (eventType === "DONE") {
                  break;
                }
                continue;
              }

              // Accumulate text or reasoning chunks.
              if (msgData.data?.type === "text" && msgData.data.text) {
                accumulatedText += msgData.data.text;
              } else if (msgData.data?.type === "reasoning" && msgData.data.reasoning) {
                accumulatedReasoning += msgData.data.reasoning;
              }
            } catch {
              log.warn(`Failed to parse message event: ${sseEvent.data.slice(0, 120)}`);
            }
          }

          if (sseEvent.event === "usage") {
            try {
              const usageData = JSON.parse(sseEvent.data) as MerlinUsageEvent;
              if (usageData.cost?.dailyUsage) {
                log.debug(
                  `Merlin usage — daily: ${usageData.cost.dailyUsage.usage}/${usageData.cost.dailyUsage.limit}, ` +
                    `plan: ${usageData.userPlan ?? "unknown"}`,
                );
              }
            } catch {
              // Usage parsing is best-effort.
            }
          }
        }

        if (hadError) {
          if (!accumulatedText && !accumulatedReasoning) {
            throw new Error(`Merlin API error: ${errorMessage}`);
          } else {
            log.warn(`Merlin API reported an error after partial response: ${errorMessage}`);
          }
        }

        // Use text content, falling back to reasoning if text is empty.
        const responseText = accumulatedText || accumulatedReasoning;

        // Try to parse tool calls from the response.
        const parsedToolCalls = context.tools?.length ? tryParseToolCalls(responseText) : undefined;

        const messageContent: (TextContent | ToolCall)[] = [];
        if (parsedToolCalls) {
          // If we successfully parsed tool calls, emit them as ToolCall content.
          for (const tc of parsedToolCalls) {
            messageContent.push({
              type: "toolCall",
              id: `merlin_call_${randomUUID()}`,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
        } else if (responseText) {
          messageContent.push({ type: "text", text: responseText });
        }

        const stopReason = parsedToolCalls ? "toolUse" : "stop";

        const assistantMessage: AssistantMessage = buildStreamAssistantMessage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content: messageContent,
          stopReason,
          usage: buildUsageWithNoCost({}),
        });

        stream.push({
          type: "done",
          reason: stopReason === "toolUse" ? "toolUse" : "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage: errMsg,
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export function createConfiguredMerlinStreamFn(_params: {
  model: { baseUrl?: string; headers?: unknown };
}): StreamFn {
  return createMerlinStreamFn();
}
