import { createRequire } from "node:module";
import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost } from "../host.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import type { Context, Model } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  buildGoogleInteractionsSimpleThinking,
  type GoogleApiType,
  type GoogleProviderOptions,
} from "./google-shared.js";

const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com";

let packageVersionMemo: string | undefined;

function resolvePackageVersion(): string {
  if (packageVersionMemo) {
    return packageVersionMemo;
  }
  if (typeof process !== "undefined" && process.env?.OPENCLAW_VERSION) {
    packageVersionMemo = process.env.OPENCLAW_VERSION;
    return packageVersionMemo;
  }
  try {
    const require = createRequire(import.meta.url);
    const candidates = [
      "../package.json",
      "../../package.json",
      "../../../package.json",
      "../../../../package.json",
    ];
    for (const candidate of candidates) {
      try {
        const parsed = asRecord(require(candidate));
        const name = readStringField(parsed, "name");
        const version = readStringField(parsed, "version");
        if (version && (name === "openclaw" || name === "@openclaw/ai")) {
          packageVersionMemo = version;
          return packageVersionMemo;
        }
      } catch {
        // Continue to the next package root candidate.
      }
    }
  } catch {
    // Fall through to the standalone package fallback.
  }
  packageVersionMemo = "0.0";
  return packageVersionMemo;
}

export function resolveGoogleApiClientHeaders(params?: {
  api?: string;
  baseUrl?: string;
  model?: Model;
}): Record<string, string> {
  const hostHeaders = getAiTransportHost().resolveProviderRequestHeaders({
    provider: "google",
    api: params?.api ?? params?.model?.api ?? "google-generative-ai",
    baseUrl: params?.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL,
    model: params?.model,
  });
  if (hostHeaders?.["x-goog-api-client"]) {
    return hostHeaders;
  }
  return {
    ...hostHeaders,
    "x-goog-api-client": `openclaw/${resolvePackageVersion()}`,
  };
}

type GoogleInteractionsStep =
  | {
      type: "user_input";
      content: Array<
        { type: "text"; text: string } | { type: "image"; mime_type: string; data: string }
      >;
    }
  | {
      type: "thought";
      signature?: string;
      summary?: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "model_output";
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "function_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "function_result";
      call_id: string;
      name: string;
      result: unknown;
      is_error: boolean;
    };

export type GoogleInteractionsRequestBody = {
  model: string;
  input: GoogleInteractionsStep[];
  system_instruction?: string;
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  generation_config?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_output_tokens?: number;
    stop_sequences?: string[];
    thinking_level?: string;
    thinking_summaries?: "auto" | "none";
    tool_choice?: "auto" | "none" | "any";
  };
  store: boolean;
  stream: boolean;
};

function convertToolResultContent(content: Context["messages"][number]["content"]): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item) => {
    if (item.type === "image") {
      return { type: "image", mime_type: item.mimeType, data: item.data };
    }
    if (item.type === "text") {
      return { type: "text", text: sanitizeSurrogates(item.text) };
    }
    return item;
  });
}

function convertMessages<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
): GoogleInteractionsStep[] {
  const steps: GoogleInteractionsStep[] = [];
  const messages = transformMessages(context.messages, model);

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        steps.push({
          type: "user_input",
          content: [{ type: "text", text: sanitizeSurrogates(message.content) || " " }],
        });
        continue;
      }
      const content: Extract<GoogleInteractionsStep, { type: "user_input" }>["content"] =
        message.content.map((item) =>
          item.type === "text"
            ? { type: "text", text: sanitizeSurrogates(item.text) || " " }
            : { type: "image", mime_type: item.mimeType, data: item.data },
        );
      steps.push({
        type: "user_input",
        content: content.length > 0 ? content : [{ type: "text", text: " " }],
      });
      continue;
    }

    if (message.role === "toolResult") {
      steps.push({
        type: "function_result",
        call_id: message.toolCallId,
        name: message.toolName || "tool",
        result: convertToolResultContent(message.content),
        is_error: message.isError,
      });
      continue;
    }

    if (message.stopReason === "error") {
      continue;
    }
    const failedPlaceholder =
      message.content.length === 1 &&
      message.content[0]?.type === "text" &&
      message.content[0].text.includes("[assistant turn failed before producing content]");
    if (failedPlaceholder) {
      continue;
    }

    let pendingText: string[] = [];
    const flushText = () => {
      if (pendingText.length === 0) {
        return;
      }
      steps.push({
        type: "model_output",
        content: [{ type: "text", text: pendingText.join("\n\n") }],
      });
      pendingText = [];
    };

    for (const block of message.content) {
      if (block.type === "thinking") {
        flushText();
        if (block.thinkingSignature) {
          steps.push({
            type: "thought",
            signature: block.thinkingSignature,
            ...(block.thinking.trim()
              ? { summary: [{ type: "text", text: sanitizeSurrogates(block.thinking) }] }
              : {}),
          });
        }
        continue;
      }
      if (block.type === "text") {
        if (block.text.trim()) {
          pendingText.push(sanitizeSurrogates(block.text));
        }
        continue;
      }

      flushText();
      if (
        block.thoughtSignature &&
        block.thoughtSignature !== "skip_thought_signature_validator" &&
        !message.content.some((candidate) => candidate.type === "thinking")
      ) {
        steps.push({ type: "thought", signature: block.thoughtSignature });
      }
      steps.push({
        type: "function_call",
        id: block.id,
        name: block.name,
        arguments: block.arguments ?? {},
      });
    }
    flushText();
  }

  return steps;
}

export function buildGoogleInteractionsParams<T extends GoogleApiType>(
  model: Model<T>,
  context: Context,
  options: GoogleProviderOptions = {},
): GoogleInteractionsRequestBody {
  const optionRecord = asRecord(options);
  if (optionRecord.cachedContent || optionRecord.cached_content) {
    throw new Error(
      "Explicit prompt caching ('cachedContent') is not supported with the Gemini Interactions API. The Interactions API handles caching implicitly on the server.",
    );
  }
  if (optionRecord.videoMetadata || optionRecord.video_metadata) {
    throw new Error(
      "video_metadata clipping offsets are not supported with the Gemini Interactions API.",
    );
  }

  const generationConfig: NonNullable<GoogleInteractionsRequestBody["generation_config"]> = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.max_output_tokens = options.maxTokens;
  }
  if (options.stop && options.stop.length > 0) {
    generationConfig.stop_sequences = options.stop;
  }
  if (options.thinking) {
    generationConfig.thinking_summaries = options.thinking.enabled ? "auto" : "none";
    const thinkingLevel =
      options.thinking.level ??
      (options.thinking.enabled
        ? undefined
        : buildGoogleInteractionsSimpleThinking(model, { reasoning: "off" }).level);
    if (thinkingLevel) {
      generationConfig.thinking_level = thinkingLevel.toLowerCase();
    }
  }
  if (options.toolChoice) {
    generationConfig.tool_choice = options.toolChoice;
  }

  const tools: GoogleInteractionsRequestBody["tools"] = context.tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: asRecord(tool.parameters),
  }));
  return {
    model: model.id,
    input: convertMessages(model, context),
    ...(context.systemPrompt
      ? {
          system_instruction: sanitizeSurrogates(
            stripSystemPromptCacheBoundary(context.systemPrompt),
          ),
        }
      : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    store: false,
    stream: true,
  };
}
