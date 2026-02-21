/**
 * Native Anthropic SDK streaming transport.
 *
 * Bypasses pi-ai's `streamSimple` (which has a hardcoded 300s HTTP timeout)
 * and uses `@anthropic-ai/sdk` directly. This enables:
 *   - Prompt caching via `cache_control: { type: "ephemeral" }` on system blocks
 *   - Extended thinking via `thinking: { type: "enabled", budget_tokens }`
 *   - No artificial timeout — long-running agentic loops complete naturally
 *
 * Pattern follows `ollama-stream.ts`: a `createXxxStreamFn(…): StreamFn` factory
 * that returns an event-stream-based StreamFn compatible with pi-agent-core.
 *
 * See: https://github.com/openclaw/openclaw/issues/19534
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// ── Message conversion ──────────────────────────────────────────────────────

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string }
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

export function convertToAnthropicMessages(
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>,
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    const { role } = msg;

    if (role === "user") {
      const blocks = buildUserContentBlocks(msg.content);
      if (blocks.length > 0) {
        result.push({ role: "user", content: blocks });
      }
    } else if (role === "assistant") {
      const blocks = buildAssistantContentBlocks(msg.content);
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
    } else if (role === "tool" || role === "toolResult") {
      const toolUseId =
        typeof msg.toolCallId === "string"
          ? msg.toolCallId
          : typeof msg.toolUseId === "string"
            ? msg.toolUseId
            : typeof msg.tool_use_id === "string"
              ? msg.tool_use_id
              : `tool_${randomUUID()}`;

      const text = extractTextContent(msg.content);
      const isError = msg.isError === true || msg.is_error === true;

      const toolResultBlock: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result" as const,
        tool_use_id: toolUseId,
        content: text || undefined,
        ...(isError ? { is_error: true } : {}),
      };

      // Merge into previous user message if it exists
      const last = result[result.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(toolResultBlock);
      } else {
        result.push({ role: "user", content: [toolResultBlock] });
      }
    }
  }

  // Anthropic requires alternating user/assistant messages.
  // Merge consecutive same-role messages.
  const merged: Anthropic.Messages.MessageParam[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : typeof prev.content === "string"
          ? [{ type: "text" as const, text: prev.content }]
          : [];
      const msgContent = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string"
          ? [{ type: "text" as const, text: msg.content }]
          : [];
      prev.content = [...prevContent, ...msgContent] as Anthropic.Messages.ContentBlockParam[];
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

function buildUserContentBlocks(content: unknown): Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const part of content as InputContentPart[]) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: ((part as { mimeType?: string }).mimeType ?? "image/png") as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data: part.data,
        },
      });
    }
  }
  return blocks;
}

function buildAssistantContentBlocks(content: unknown): Anthropic.Messages.ContentBlockParam[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const part of content as InputContentPart[]) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.arguments,
      });
    } else if (part.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      });
    }
  }
  return blocks;
}

// ── Tool conversion ─────────────────────────────────────────────────────────

export function convertTools(tools: Tool[] | undefined): Anthropic.Messages.Tool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: Anthropic.Messages.Tool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema: {
        type: "object" as const,
        ...(tool.parameters as Record<string, unknown>),
      },
    });
  }
  return result;
}

// ── Thinking level → budget mapping ─────────────────────────────────────────

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

function resolveThinkingConfig(
  reasoning: string | undefined,
  thinkingBudgets: Record<string, number | undefined> | undefined,
): { type: "enabled"; budget_tokens: number } | undefined {
  if (!reasoning) {
    return undefined;
  }
  const customBudget = thinkingBudgets?.[reasoning];
  const budget = customBudget ?? DEFAULT_THINKING_BUDGETS[reasoning] ?? 10000;
  return { type: "enabled", budget_tokens: budget };
}

// ── Main StreamFn factory ───────────────────────────────────────────────────

export function createAnthropicNativeStreamFn(
  apiKey: string,
  opts?: { baseUrl?: string },
): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const effectiveApiKey = options?.apiKey || apiKey;

        const client = new Anthropic({
          apiKey: effectiveApiKey,
          ...(opts?.baseUrl ? { baseURL: opts.baseUrl } : {}),
          defaultHeaders: {
            "anthropic-beta": [
              "fine-grained-tool-streaming-2025-05-14",
              "interleaved-thinking-2025-05-14",
            ].join(","),
          },
        });

        const anthropicMessages = convertToAnthropicMessages(
          (context.messages ?? []) as unknown as Array<{
            role: string;
            content: unknown;
            [key: string]: unknown;
          }>,
        );
        const anthropicTools = convertTools(context.tools);

        const maxTokens = options?.maxTokens || model.maxTokens || 8192;

        // Build system prompt with prompt caching
        const system: Anthropic.Messages.TextBlockParam[] | undefined = context.systemPrompt
          ? [
              {
                type: "text" as const,
                text: context.systemPrompt,
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : undefined;

        // Build thinking config from reasoning level + optional budgets
        const thinking = resolveThinkingConfig(
          (options as Record<string, unknown> | undefined)?.reasoning as string | undefined,
          (options as Record<string, unknown> | undefined)?.thinkingBudgets as
            | Record<string, number | undefined>
            | undefined,
        );

        const params: Anthropic.Messages.MessageCreateParams = {
          model: model.id,
          max_tokens: maxTokens,
          messages: anthropicMessages,
          ...(system ? { system } : {}),
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          ...(thinking ? { thinking } : {}),
          ...(typeof options?.temperature === "number" ? { temperature: options.temperature } : {}),
        };

        const messageStream = client.messages.stream(params, {
          signal: options?.signal ?? undefined,
        });

        // Wait for the complete message
        const finalMsg = await messageStream.finalMessage();

        // Build pi-ai content from Anthropic response content blocks
        const content: (TextContent | ToolCall)[] = [];
        for (const block of finalMsg.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            content.push({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: (block.input ?? {}) as Record<string, unknown>,
            });
          }
          // thinking blocks are not included in the final assistant message
        }

        const hasToolCalls = content.some((c) => c.type === "toolCall");
        const piStopReason: StopReason = hasToolCalls
          ? "toolUse"
          : finalMsg.stop_reason === "max_tokens"
            ? "length"
            : "stop";

        const inputTokens = finalMsg.usage.input_tokens;
        const outputTokens = finalMsg.usage.output_tokens;
        const cacheReadTokens = finalMsg.usage.cache_read_input_tokens ?? 0;
        const cacheCreationTokens = finalMsg.usage.cache_creation_input_tokens ?? 0;

        const usage: Usage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheReadTokens,
          cacheWrite: cacheCreationTokens,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content,
          stopReason: piStopReason,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          timestamp: Date.now(),
        };

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          piStopReason === "toolUse" ? "toolUse" : piStopReason === "length" ? "length" : "stop";

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
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
