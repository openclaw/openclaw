// Vertex AI Express Mode transport.
//
// Express Mode uses the same Google Generative AI JSON payload format but
// targets the global aiplatform.googleapis.com endpoint and authenticates via
// a query-parameter API key rather than the x-goog-api-key header.
//
// Payload construction is delegated to the shared google extension's
// `buildGoogleGenerativeAiParams` / SSE-parsing logic via the
// `google-generative-ai` api family. The only material difference is the URL
// and the credential attachment strategy.

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  getEnvApiKey,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
  stripSystemPromptCacheBoundary,
  transformTransportMessages,
  type WritableTransportStream,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { VERTEX_EXPRESS_BASE_URL, VERTEX_EXPRESS_PROVIDER_ID } from "./onboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VertexExpressModel = Model<"google-generative-ai"> & {
  headers?: Record<string, string>;
  provider: string;
};

type VertexExpressOptions = SimpleStreamOptions & {
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | {
        type: "function";
        function: { name: string };
      };
};

type GoogleGenerateContentRequest = {
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

type GoogleSseChunk = {
  responseId?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

type VertexExpressContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<VertexExpressContentBlock>;
  api: "google-generative-ai";
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
  stopReason: string;
  timestamp: number;
  responseId?: string;
};

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

function resolveVertexExpressModelPath(modelId: string): string {
  // Express Mode uses publishers/google/models/<modelId> path
  if (modelId.startsWith("publishers/") || modelId.startsWith("models/")) {
    return modelId;
  }
  return `publishers/google/models/${modelId}`;
}

/**
 * Builds the Vertex AI Express Mode streaming URL.
 *
 * Format: https://aiplatform.googleapis.com/v1/publishers/google/models/<modelId>:streamGenerateContent?key=<apiKey>&alt=sse
 *
 * Unlike Google AI Studio, the API key is passed as a query parameter, not
 * in the `x-goog-api-key` request header.
 */
export function buildVertexExpressUrl(modelId: string, apiKey: string): string {
  const base = VERTEX_EXPRESS_BASE_URL.replace(/\/$/, "");
  const modelPath = resolveVertexExpressModelPath(modelId);
  return `${base}/${modelPath}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;
}

// ---------------------------------------------------------------------------
// Helpers: message conversion
// ---------------------------------------------------------------------------



function mapToolChoice(
  choice: VertexExpressOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function mapStopReason(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

function convertMessages(model: VertexExpressModel, context: Context): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  const transformed = transformTransportMessages(context.messages, model, (id) => id);

  for (const msg of transformed) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeTransportPayloadText(msg.content) }],
        });
        continue;
      }
      const parts = msg.content
        .map((item) =>
          item.type === "text"
            ? { text: sanitizeTransportPayloadText(item.text) }
            : {
                inlineData: {
                  mimeType: item.mimeType,
                  data: item.data,
                },
              },
        )
        .filter((item) => model.input.includes("image") || !("inlineData" in item));
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const isSameProviderAndModel =
        msg.provider === model.provider && msg.model === model.id;
      const parts: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) {
            continue;
          }
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(isSameProviderAndModel && block.textSignature
              ? { thoughtSignature: block.textSignature }
              : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.thinking.trim()) {
            continue;
          }
          parts.push(
            isSameProviderAndModel
              ? {
                  thought: true,
                  text: sanitizeTransportPayloadText(block.thinking),
                  ...(block.thinkingSignature
                    ? { thoughtSignature: block.thinkingSignature }
                    : {}),
                }
              : { text: sanitizeTransportPayloadText(block.thinking) },
          );
          continue;
        }
        if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              name: block.name,
              args: coerceTransportToolCallArguments(block.arguments),
            },
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter(
          (item): item is Extract<(typeof msg.content)[number], { type: "text" }> =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      const responseValue = textResult ? sanitizeTransportPayloadText(textResult) : "";
      const functionResponse = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
        },
      };
      const last = contents[contents.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.parts) &&
        last.parts.some((p) => "functionResponse" in p)
      ) {
        (last.parts as Array<Record<string, unknown>>).push(functionResponse);
      } else {
        contents.push({ role: "user", parts: [functionResponse] });
      }
    }
  }
  return contents;
}

function buildRequestBody(
  model: VertexExpressModel,
  context: Context,
  options?: VertexExpressOptions,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }

  const params: GoogleGenerateContentRequest = {
    contents: convertMessages(model, context),
  };
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(
            stripSystemPromptCacheBoundary(context.systemPrompt),
          ),
        },
      ],
    };
  }
  if (context.tools?.length) {
    params.tools = [
      {
        functionDeclarations: context.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      },
    ];
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = { functionCallingConfig: toolChoice };
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

async function* parseSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        yield JSON.parse(data) as GoogleSseChunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

function updateUsage(
  output: MutableAssistantOutput,
  model: VertexExpressModel,
  chunk: GoogleSseChunk,
) {
  const usage = chunk.usageMetadata;
  if (!usage) {
    return;
  }
  const promptTokens = usage.promptTokenCount ?? 0;
  const cacheRead = usage.cachedContentTokenCount ?? 0;
  output.usage = {
    input: Math.max(0, promptTokens - cacheRead),
    output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheRead,
    cacheWrite: 0,
    totalTokens: usage.totalTokenCount ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, output.usage);
}

function pushBlockEnd(
  stream: WritableTransportStream,
  output: MutableAssistantOutput,
  blockIndex: number,
) {
  const block = output.content[blockIndex];
  if (!block) {
    return;
  }
  if (block.type === "thinking") {
    stream.push({
      type: "thinking_end",
      contentIndex: blockIndex,
      content: block.thinking,
      partial: output as never,
    });
    return;
  }
  if (block.type === "text") {
    stream.push({
      type: "text_end",
      contentIndex: blockIndex,
      content: block.text,
      partial: output as never,
    });
  }
}

// ---------------------------------------------------------------------------
// Public: StreamFn factory
// ---------------------------------------------------------------------------

/**
 * Creates the StreamFn for Google Vertex AI Express Mode.
 *
 * The key structural difference vs. standard Google AI Studio:
 *   - URL: `https://aiplatform.googleapis.com/v1/publishers/google/models/<id>:streamGenerateContent?key=<apiKey>&alt=sse`
 *   - Auth: API key in query param, NOT in `x-goog-api-key` header.
 */
export function createVertexExpressTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    let toolCallCounter = 0;
    const model = rawModel as VertexExpressModel;
    const options = rawOptions as VertexExpressOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();

    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: "google-generative-ai",
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        const apiKey =
          options?.apiKey ?? getEnvApiKey(VERTEX_EXPRESS_PROVIDER_ID) ?? undefined;
        if (!apiKey) {
          throw new Error(
            `No API key found for provider "${VERTEX_EXPRESS_PROVIDER_ID}". ` +
              "Set GOOGLE_VERTEX_EXPRESS_API_KEY or run `openclaw onboard`.",
          );
        }

        const requestUrl = buildVertexExpressUrl(model.id, apiKey);
        const body = buildRequestBody(model, context, options);
        const nextBody = await options?.onPayload?.(body, model);
        const finalBody = nextBody !== undefined ? (nextBody as GoogleGenerateContentRequest) : body;

        const headers =
          mergeTransportHeaders(
            { accept: "text/event-stream", "content-type": "application/json" },
            model.headers,
            options?.headers,
          ) ?? { accept: "text/event-stream", "content-type": "application/json" };

        const guardedFetch = buildGuardedModelFetch(model);
        const response = await guardedFetch(requestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(finalBody),
          signal: options?.signal,
        });

        if (!response.ok) {
          throw await createProviderHttpError(
            response,
            "Google Vertex AI (Express Mode) API error",
          );
        }

        stream.push({ type: "start", partial: output as never });
        let currentBlockIndex = -1;

        for await (const chunk of parseSseChunks(response, options?.signal)) {
          output.responseId ||= chunk.responseId;
          updateUsage(output, model, chunk);
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (typeof part.text === "string") {
                const isThinking = part.thought === true;
                const currentBlock = output.content[currentBlockIndex];
                if (
                  currentBlockIndex < 0 ||
                  !currentBlock ||
                  (isThinking && currentBlock.type !== "thinking") ||
                  (!isThinking && currentBlock.type !== "text")
                ) {
                  if (currentBlockIndex >= 0) {
                    pushBlockEnd(stream, output, currentBlockIndex);
                  }
                  if (isThinking) {
                    output.content.push({ type: "thinking", thinking: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "thinking_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  } else {
                    output.content.push({ type: "text", text: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "text_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  }
                }
                const activeBlock = output.content[currentBlockIndex];
                if (activeBlock?.type === "thinking") {
                  activeBlock.thinking += part.text;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                  });
                } else if (activeBlock?.type === "text") {
                  activeBlock.text += part.text;
                  stream.push({
                    type: "text_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                  });
                }
              }

              if (part.functionCall) {
                if (currentBlockIndex >= 0) {
                  pushBlockEnd(stream, output, currentBlockIndex);
                  currentBlockIndex = -1;
                }
                const providedId = part.functionCall.id;
                const isDuplicate = output.content.some(
                  (block) => block.type === "toolCall" && block.id === providedId,
                );
                const toolCallId =
                  providedId && !isDuplicate
                    ? providedId
                    : `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
                const toolCall: VertexExpressContentBlock = {
                  type: "toolCall",
                  id: toolCallId,
                  name: part.functionCall.name ?? "",
                  arguments: part.functionCall.args ?? {},
                  thoughtSignature: part.thoughtSignature,
                };
                output.content.push(toolCall);
                const blockIndex = output.content.length - 1;
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex,
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex,
                  delta: JSON.stringify(toolCall.arguments),
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: blockIndex,
                  toolCall,
                  partial: output as never,
                });
              }
            }
          }
          if (typeof candidate?.finishReason === "string") {
            output.stopReason = mapStopReason(candidate.finishReason);
            if (output.content.some((block) => block.type === "toolCall")) {
              output.stopReason = "toolUse";
            }
          }
        }

        if (currentBlockIndex >= 0) {
          pushBlockEnd(stream, output, currentBlockIndex);
        }
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();

    return eventStream as unknown as ReturnType<StreamFn>;
  };
}
