import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { LocalServerBodyTemplate } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAssistantMessage,
  buildStreamErrorAssistantMessage,
  buildUsageWithNoCost,
} from "./stream-message-shared.js";

const log = createSubsystemLogger("local-server-stream");

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("");
}

function buildPromptFromMessages(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt?: string,
): string {
  // Only use the last user message as the prompt, not the full system prompt.
  // The system prompt is enormous and will break JSON templates.
  const lastUserMsg = [...messages].toReversed().find((m) => m.role === "user");
  if (lastUserMsg) {
    return extractTextContent(lastUserMsg.content);
  }
  // Fallback: join all non-system messages
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`System: ${systemPrompt}`);
  }
  for (const msg of messages) {
    const text = extractTextContent(msg.content);
    if (text) {
      parts.push(`${msg.role}: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function buildMessagesJson(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt?: string,
): string {
  const formatted: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    formatted.push({ role: "system", content: systemPrompt });
  }
  for (const msg of messages) {
    formatted.push({ role: msg.role, content: extractTextContent(msg.content) });
  }
  return JSON.stringify(formatted);
}

/**
 * Escape a string value for safe inline substitution inside a JSON string context.
 * JSON.stringify("hello\nworld") → '"hello\\nworld"' -- we strip the outer quotes.
 */
function escapeForJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Substitute placeholders in the body template with actual values in a single
 * pass so that content injected by one replacement cannot be matched by a
 * subsequent placeholder pattern (e.g. a user message containing "{{model}}").
 *
 * String placeholders ({{prompt}}, {{system}}, {{model}}) are escaped so
 * newlines, quotes and other special characters don't break the JSON.
 *
 * Raw placeholders ({{messages}} and {{max_tokens}}) replace the whole value
 * including any surrounding quotes so the result is valid JSON.
 */
function substituteTemplate(
  template: string,
  params: {
    prompt: string;
    messages: string;
    system: string;
    model: string;
    maxTokens: number;
  },
): string {
  return template.replace(
    /"?\{\{(prompt|messages|system|model|max_tokens)\}\}"?/g,
    (match, key) => {
      switch (key) {
        case "prompt":
          return escapeForJsonString(params.prompt);
        case "messages":
          return params.messages;
        case "system":
          return escapeForJsonString(params.system);
        case "model":
          return escapeForJsonString(params.model);
        case "max_tokens":
          return String(params.maxTokens);
        default:
          return match;
      }
    },
  );
}

/**
 * Extract a value from a nested object using dot-notation path.
 * Supports array indexing: "choices.0.message.content"
 */
function extractByPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function createLocalServerStreamFn(
  endpointUrl: string,
  localServer: LocalServerBodyTemplate,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const messages = context.messages ?? [];
        const systemPrompt = context.systemPrompt ?? "";

        const prompt = buildPromptFromMessages(messages, systemPrompt);
        const messagesJson = buildMessagesJson(messages, systemPrompt);
        const maxTokens = options?.maxTokens ?? model.maxTokens ?? 4096;

        const bodyStr = substituteTemplate(localServer.template, {
          prompt,
          messages: messagesJson,
          system: systemPrompt,
          model: model.id,
          maxTokens,
        });

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyStr);
        } catch {
          throw new Error(
            `Local server body template produced invalid JSON after substitution: ${bodyStr.slice(0, 200)}`,
          );
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...defaultHeaders,
          ...options?.headers,
        };
        if (options?.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        log.info(`POST ${endpointUrl}`);

        const response = await fetch(endpointUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(parsedBody),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Local server error ${response.status}: ${errorText}`);
        }

        const responseJson = (await response.json()) as unknown;

        const extracted = extractByPath(responseJson, localServer.responsePath);

        let text: string;
        if (typeof extracted === "string") {
          text = extracted;
        } else if (extracted != null) {
          text = JSON.stringify(extracted);
        } else {
          log.warn(
            `Response path "${localServer.responsePath}" returned null/undefined. ` +
              `Full response: ${JSON.stringify(responseJson).slice(0, 300)}`,
          );
          text = "";
        }

        const content: TextContent[] = text ? [{ type: "text", text }] : [];

        const assistantMessage = buildAssistantMessage({
          model: { api: model.api, provider: model.provider, id: model.id },
          content,
          stopReason: "stop",
          usage: buildUsageWithNoCost({}),
        });

        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`Local server stream error: ${errorMessage}`);
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
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
