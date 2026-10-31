import { asRecord } from "@openclaw/normalization-core/record-coerce";
import packageManifest from "../../package.json" with { type: "json" };
import { getAiTransportHost } from "../host.js";
import { transformProviderMessages } from "../provider-transcript-transform.js";
import {
  PROVIDER_MODEL_INPUT,
  type ProviderContext,
  type ProviderModel,
  type ProviderStreamOptions,
} from "../provider-types.js";
import type { Model, ModelRequestHeaders } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  buildGoogleInteractionsSimpleThinking,
  type GoogleApiType,
  type GoogleProviderOptions,
} from "./google-shared.js";

let packageVersionMemo: string | undefined;

export function resolveGoogleApiClientHeaders(params: {
  baseUrl: string;
  model: Model;
}): ModelRequestHeaders {
  const hostHeaders = getAiTransportHost().resolveProviderRequestHeaders({
    provider: "google",
    api: "google-generative-ai",
    baseUrl: params.baseUrl,
    model: params.model,
  });
  if (hostHeaders?.["x-goog-api-client"]) {
    return hostHeaders;
  }
  return {
    ...hostHeaders,
    "x-goog-api-client": `openclaw/${(packageVersionMemo ||=
      (typeof process !== "undefined" && process.env?.OPENCLAW_VERSION) ||
      packageManifest.version)}`,
  };
}

type GoogleInteractionsStep =
  | {
      type: "user_input";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; mime_type: string; data: string }
        | { type: "video"; mime_type: string; data: string; processing?: Record<string, unknown> }
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

function convertMessages<T extends GoogleApiType>(
  model: ProviderModel<T>,
  context: ProviderContext,
  videoMetadata: Record<string, unknown>,
): GoogleInteractionsStep[] {
  const steps: GoogleInteractionsStep[] = [];
  // Canonical transcript types omit video; blocks the provider input admits survive
  // the transform, as on the GenerateContent projection.
  const messages = transformProviderMessages(
    context.messages,
    model,
  ) as ProviderContext["messages"];

  for (const message of messages) {
    if (message.role === "user") {
      const sourceContent = message.content;
      const parts =
        typeof sourceContent === "string"
          ? [{ type: "text" as const, text: sourceContent }]
          : sourceContent;
      const content: Extract<GoogleInteractionsStep, { type: "user_input" }>["content"] = parts.map(
        (item) => {
          if (item.type === "text") {
            return { type: "text", text: sanitizeSurrogates(item.text) || " " };
          }
          if (item.type === "video" && Object.keys(videoMetadata).length > 0) {
            return {
              type: "video",
              mime_type: item.mimeType,
              data: item.data,
              processing: Object.assign({ type: "static" }, videoMetadata),
            };
          }
          return { type: item.type, mime_type: item.mimeType, data: item.data };
        },
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
        result: message.content.map((item) =>
          item.type === "image"
            ? { type: "image", mime_type: item.mimeType, data: item.data }
            : { type: "text", text: sanitizeSurrogates(item.text) },
        ),
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
        arguments: block.arguments,
      });
    }
    flushText();
  }

  return steps;
}

export function buildGoogleInteractionsParams<T extends GoogleApiType>(
  model: Model<T>,
  context: ProviderContext,
  options: GoogleProviderOptions &
    ProviderStreamOptions & {
      videoMetadata?: Record<string, unknown>;
      video_metadata?: Record<string, unknown>;
    } = {},
): GoogleInteractionsRequestBody {
  const optionRecord = asRecord(options);
  const metadata = asRecord(optionRecord.videoMetadata ?? optionRecord.video_metadata);
  const videoMetadata: Record<string, unknown> = {};
  for (const [camel, snake] of [
    ["startOffset", "start_offset"],
    ["endOffset", "end_offset"],
    ["fps", "fps"],
  ] as const) {
    const value = metadata[camel] ?? metadata[snake];
    if (value !== undefined) {
      videoMetadata[snake] = value;
    }
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
    // Video admission follows the provider-normalized input (official AI Studio
    // Flash models), not the canonical text/image model input.
    input: convertMessages(
      { ...model, input: options[PROVIDER_MODEL_INPUT] ?? model.input },
      context,
      videoMetadata,
    ),
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
