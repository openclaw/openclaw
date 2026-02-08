import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";

// ── Ollama /api/chat request types ──────────────────────────────────────────

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

// ── Ollama /api/chat response types ─────────────────────────────────────────

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ── Message conversion ──────────────────────────────────────────────────────

type AgentMessage = {
  role: string;
  content: unknown;
  [key: string]: unknown;
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as ContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as ContentPart[])
    .filter((part): part is { type: "image"; data: string } => part.type === "image")
    .map((part) => part.data);
}

function extractToolCalls(content: unknown): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as ContentPart[])
    .filter(
      (part): part is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        part.type === "tool_use",
    )
    .map((part) => ({
      function: {
        name: part.name,
        arguments: part.input,
      },
    }));
}

export function convertToOllamaMessages(
  messages: AgentMessage[],
  system?: string,
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const role = msg.role as string;

    if (role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool") {
      const text = extractTextContent(msg.content);
      result.push({ role: "tool", content: text });
    }
  }

  return result;
}

// ── Response conversion ─────────────────────────────────────────────────────

interface AssistantMessageLike {
  role: "assistant";
  content: ContentPart[];
  stopReason: string;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  timestamp: number;
}

let toolCallIdCounter = 0;

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessageLike {
  const content: ContentPart[] = [];

  if (response.message.content) {
    content.push({ type: "text", text: response.message.content });
  }

  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      toolCallIdCounter += 1;
      content.push({
        type: "tool_use",
        id: `ollama_call_${toolCallIdCounter}_${Date.now()}`,
        name: tc.function.name,
        input: tc.function.arguments,
      });
    }
  }

  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const stopReason = hasToolCalls ? "end_turn" : "stop";

  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage: {
      input: response.prompt_eval_count ?? 0,
      output: response.eval_count ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

// ── NDJSON streaming parser ─────────────────────────────────────────────────

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        // Skip malformed lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as OllamaChatResponse;
    } catch {
      // Skip malformed trailing data
    }
  }
}

// ── Main StreamFn factory ───────────────────────────────────────────────────

export function createOllamaStreamFn(baseUrl: string): StreamFn {
  const chatUrl = `${baseUrl.replace(/\/+$/, "")}/api/chat`;

  return (model, context, options) => {
    const stream = new AssistantMessageEventStream();

    const run = async () => {
      try {
        const ctx = context as { messages?: AgentMessage[]; system?: string };
        const ollamaMessages = convertToOllamaMessages(ctx.messages ?? [], ctx.system as string);

        const body: OllamaChatRequest = {
          model: model.id,
          messages: ollamaMessages,
          stream: true,
          ...(typeof options?.temperature === "number"
            ? { options: { temperature: options.temperature } }
            : {}),
        };

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(options?.headers ?? {}),
        };
        if (options?.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Ollama API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();
        let accumulatedContent = "";
        let finalResponse: OllamaChatResponse | undefined;

        for await (const chunk of parseNdjsonStream(reader)) {
          if (chunk.done) {
            finalResponse = chunk;
            if (chunk.message?.content) {
              accumulatedContent += chunk.message.content;
            }
            break;
          }

          if (chunk.message?.content) {
            accumulatedContent += chunk.message.content;
          }
        }

        if (!finalResponse) {
          throw new Error("Ollama API stream ended without a final response");
        }

        finalResponse.message.content = accumulatedContent;

        const assistantMessage = buildAssistantMessage(finalResponse, {
          api: model.api as string,
          provider: model.provider as string,
          id: model.id,
        });

        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "done",
          reason: "error",
          message: {
            role: "assistant" as const,
            content: [],
            stopReason: "error",
            errorMessage,
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
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
