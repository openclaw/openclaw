/**
 * Custom StreamFn for providers that don't support SSE streaming (e.g. Straico).
 *
 * These providers return plain JSON (`application/json`) even when `stream: true`
 * is sent.  The OpenAI SDK expects SSE events and yields zero chunks, producing
 * empty assistant messages.  This module makes a regular (non-streaming) fetch
 * and converts the response into the pi-ai event-stream format.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason, TextContent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAssistantMessage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
  type StreamModelDescriptor,
} from "./stream-message-shared.js";

const log = createSubsystemLogger("non-streaming-openai-compat");

// ── Message conversion helpers ──────────────────────────────────────────────

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | { role: "assistant"; content: string };

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Convert pi-agent messages to a simplified OpenAI-compatible format.
 *
 * Tool-call assistant turns and tool-result messages are stripped because
 * non-streaming aggregator providers generally don't support function calling
 * in conversation history.  Only text + image content is preserved.
 */
function convertPiAgentToOpenAICompat(
  systemPrompt: string | undefined,
  messages: Array<{ role: string; content: unknown }>,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt?.trim()) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const content = msg.content;

    if (msg.role === "user") {
      if (typeof content === "string") {
        result.push({ role: "user", content });
        continue;
      }
      if (!Array.isArray(content)) {
        continue;
      }

      const parts: OpenAIContentPart[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image" && b.data && b.mimeType) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${b.mimeType as string};base64,${b.data as string}` },
          });
        }
      }

      if (parts.length === 1 && parts[0].type === "text") {
        result.push({ role: "user", content: parts[0].text });
      } else if (parts.length > 0) {
        result.push({ role: "user", content: parts });
      }
    } else if (msg.role === "assistant") {
      if (!Array.isArray(content)) {
        continue;
      }

      // Extract only text content — skip thinking blocks and tool calls.
      const textParts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          textParts.push(b.text);
        }
      }

      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      // Skip assistant messages that are only tool calls / thinking (no text).
    }
    // Skip toolResult messages — aggregators don't understand tool call context.
  }

  return result;
}

// ── StreamFn factory ────────────────────────────────────────────────────────

export function createNonStreamingOpenAICompatStreamFn(baseUrl: string): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const modelDescriptor: StreamModelDescriptor = {
      api: model.api,
      provider: model.provider,
      id: model.id,
    };

    const run = async () => {
      try {
        const messages = convertPiAgentToOpenAICompat(context.systemPrompt, context.messages as []);

        const body: Record<string, unknown> = {
          model: model.id,
          messages,
          stream: false,
        };
        if (options?.maxTokens) {
          body.max_tokens = options.maxTokens;
        }
        if (options?.temperature !== undefined) {
          body.temperature = options.temperature;
        }

        // Allow payload hooks (logging, transforms) to modify the body.
        const finalBody = (await options?.onPayload?.(body, model)) ?? body;

        const apiKey = options?.apiKey ?? "";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...options?.headers,
        };

        log.info(`[non-streaming] POST ${baseUrl}/chat/completions model=${model.id}`);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(finalBody),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`${response.status} ${errorText}`);
        }

        const json = (await response.json()) as Record<string, unknown>;
        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const messageObj = choice?.message as Record<string, unknown> | undefined;
        let text = (typeof messageObj?.content === "string" ? messageObj.content : "") || "";
        const finishReason = choice?.finish_reason as string | undefined;
        const usageObj = json.usage as Record<string, number> | undefined;

        // Perplexity Sonar (and similar) returns `annotations` with URL citations.
        // Append them as footnotes so inline `[1][2]` markers resolve to actual URLs.
        const annotations = messageObj?.annotations as
          | Array<{ type: string; url_citation?: { url: string; title?: string } }>
          | undefined;
        if (annotations?.length) {
          const seen = new Set<string>();
          const footnotes: string[] = [];
          let idx = 1;
          for (const a of annotations) {
            const url = a.url_citation?.url;
            if (!url || seen.has(url)) {
              continue;
            }
            seen.add(url);
            const title = a.url_citation?.title;
            footnotes.push(`[${idx}] ${title ? `${title} — ` : ""}${url}`);
            idx++;
          }
          if (footnotes.length > 0) {
            text = `${text}\n\n---\n**Sources:**\n${footnotes.join("\n")}`;
          }
        }

        const assistantContent: TextContent[] = text ? [{ type: "text", text }] : [];
        const stopReason: StopReason = finishReason === "length" ? "length" : "stop";

        const assistantMessage: AssistantMessage = buildAssistantMessage({
          model: modelDescriptor,
          content: assistantContent,
          stopReason,
          usage: buildUsageWithNoCost({
            input: usageObj?.prompt_tokens ?? 0,
            output: usageObj?.completion_tokens ?? 0,
            totalTokens: usageObj?.total_tokens ?? 0,
          }),
        });

        stream.push({ type: "done", reason: stopReason, message: assistantMessage });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`[non-streaming] error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({ model: modelDescriptor, errorMessage }),
        });
      }
      stream.end();
    };

    void run();
    return stream;
  };
}
