/**
 * Gemini Interactions API adapter and lifecycle for OpenClaw.
 * POST /v1beta/interactions
 */

import {
  asOptionalRecord,
  asRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { calculateCost } from "../model-utils.js";
import { buildGuardedModelFetch } from "../transports/host-policy.js";
import { parseJsonPreservingUnsafeIntegers } from "../transports/json-unsafe-integers.js";
import {
  assignTransportErrorDetails,
  notifyProviderHttpResponse,
  notifyProviderStreamOpened,
  parseTerminalToolCallArguments,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type { AssistantMessage, Context, Model, ThinkingContent, ToolCall } from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleInteractionsParams,
  resolveGoogleApiClientHeaders,
  type GoogleInteractionsRequestBody,
} from "./google-interactions-request.js";
import type { GoogleApiType, GoogleProviderOptions } from "./google-shared.js";

export type { GoogleApiType };

export function resolveGoogleInteractionsApiKey<T extends GoogleApiType>(
  model: Model<T>,
  options?: GoogleProviderOptions,
  apiKey?: string,
): string {
  return (
    apiKey ||
    options?.apiKey ||
    getEnvApiKey(model.provider) ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  );
}

function logGoogleInteractionsDebug(message: string, data?: Record<string, unknown>): void {
  getAiTransportHost().logDebug("google-interactions", () => ({ message, data }));
}

function isGoogleInteractionsRequestBody(value: unknown): value is GoogleInteractionsRequestBody {
  const record = asOptionalRecord(value);
  if (!record) {
    return false;
  }
  return (
    typeof record.model === "string" &&
    Array.isArray(record.input) &&
    typeof record.store === "boolean" &&
    typeof record.stream === "boolean"
  );
}

export async function runGoogleInteractionsLifecycle<T extends GoogleApiType>(params: {
  stream: AssistantMessageEventStream;
  model: Model<T>;
  output: AssistantMessage;
  options?: GoogleProviderOptions;
  context: Context;
  nextToolCallId: (name: string) => string;
  apiKey?: string;
}): Promise<void> {
  const { stream, model, output, options, context, nextToolCallId } = params;

  try {
    const host = getAiTransportHost();
    const unresolvedApiKey = resolveGoogleInteractionsApiKey(model, options, params.apiKey);
    const apiKey = host.resolveSecretSentinel(unresolvedApiKey);
    if (!apiKey.trim()) {
      throw new Error(`No API key for provider: ${model.provider}`);
    }
    let body = buildGoogleInteractionsParams(model, context, options);
    const nextBody = await options?.onPayload?.(body, model);
    if (nextBody !== undefined) {
      if (!isGoogleInteractionsRequestBody(nextBody)) {
        throw new Error("Google Interactions onPayload returned an invalid request body");
      }
      body = nextBody;
    }

    let baseUrl = (model.baseUrl || "https://generativelanguage.googleapis.com/v1beta")
      .trim()
      .replace(/\/+$/, "");
    if (/^https:\/\/generativelanguage\.googleapis\.com$/i.test(baseUrl)) {
      baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    }
    const url = `${baseUrl}/interactions?alt=sse`;

    const googleClientHeaders = resolveGoogleApiClientHeaders({
      baseUrl,
      api: "google-generative-ai",
      model,
    });

    const headers = resolveAiTransportHeaderSentinels({
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "Api-Revision": "2026-05-20",
      ...googleClientHeaders,
      ...model.headers,
      ...options?.headers,
    }) ?? { "Content-Type": "application/json", "x-goog-api-key": apiKey };

    logGoogleInteractionsDebug("request", {
      method: "POST",
      url,
      model: model.id,
      inputSteps: body.input.length,
      tools: body.tools?.length ?? 0,
    });

    const guardedFetch = buildGuardedModelFetch({ ...model, baseUrl }, options?.timeoutMs, {
      sanitizeSse: true,
    });
    const response = await guardedFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    await notifyProviderHttpResponse({ options, response, model });

    logGoogleInteractionsDebug("response", {
      status: response.status,
      statusText: response.statusText,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logGoogleInteractionsDebug("request failed", {
        status: response.status,
      });
      throw new Error(`Google Interactions API error HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Google Interactions API returned empty response body");
    }

    const reader = response.body.getReader();
    await notifyProviderStreamOpened({
      options,
      cancelStream: async () => {
        await reader.cancel();
      },
    });
    stream.push({ type: "start", partial: output });
    const decoder = new TextDecoder();
    let buffer = "";

    let currentBlockType: "text" | "thinking" | "toolCall" | null = null;
    let currentBlockIndex = -1;
    let currentToolCall: ToolCall | null = null;
    let currentToolArgs = "";
    let latestThoughtSignature: string | undefined;
    let latestUsage: Record<string, unknown> | undefined;

    const endCurrentBlock = () => {
      if (currentBlockType === "text") {
        const block = output.content[currentBlockIndex];
        const textBlock = block?.type === "text" ? block : undefined;
        stream.push({
          type: "text_end",
          contentIndex: currentBlockIndex,
          content: textBlock?.text ?? "",
          partial: output,
        });
      } else if (currentBlockType === "thinking") {
        const block = output.content[currentBlockIndex];
        const thinkingBlock = block?.type === "thinking" ? block : undefined;
        if (thinkingBlock && !thinkingBlock.thinkingSignature && latestThoughtSignature) {
          thinkingBlock.thinkingSignature = latestThoughtSignature;
        }
        stream.push({
          type: "thinking_end",
          contentIndex: currentBlockIndex,
          content: thinkingBlock?.thinking ?? "",
          partial: output,
        });
        latestThoughtSignature = undefined;
      } else if (currentBlockType === "toolCall" && currentToolCall) {
        if (currentToolArgs.trim()) {
          currentToolCall.arguments = parseTerminalToolCallArguments(currentToolArgs);
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: currentBlockIndex,
          toolCall: currentToolCall,
          partial: output,
        });
        currentToolCall = null;
        currentToolArgs = "";
      }
      currentBlockType = null;
    };

    let streamDone = false;
    let sawCompletion = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) {
          continue;
        }
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          streamDone = true;
          break;
        }

        let event: Record<string, unknown>;
        try {
          event = asRecord(parseJsonPreservingUnsafeIntegers(dataStr));
        } catch {
          continue;
        }

        const eventType = event.event_type || event.type;
        logGoogleInteractionsDebug("stream event", {
          eventType: typeof eventType === "string" ? eventType : "unknown",
        });

        if (eventType === "error") {
          const providerError = asOptionalRecord(event.error);
          const message =
            readStringField(providerError, "message") ?? "Google Interactions stream failed";
          const error = Object.assign(new Error(message), {
            code: readStringField(providerError, "code"),
            type: "google_interactions_stream_error",
          });
          await reader.cancel();
          throw error;
        } else if (eventType === "step.delta") {
          const delta = asOptionalRecord(event.delta);
          const deltaType = delta?.type;

          if (deltaType === "text") {
            const text = readStringField(delta, "text") ?? "";
            if (text) {
              if (currentBlockType !== "text") {
                endCurrentBlock();
                currentBlockType = "text";
                currentBlockIndex = output.content.length;
                output.content.push({ type: "text", text: "" });
                stream.push({
                  type: "text_start",
                  contentIndex: currentBlockIndex,
                  partial: output,
                });
              }
              const block = output.content[currentBlockIndex];
              if (!block || block.type !== "text") {
                throw new Error("Google Interactions text delta has no active text block");
              }
              block.text += text;
              stream.push({
                type: "text_delta",
                contentIndex: currentBlockIndex,
                delta: text,
                partial: output,
              });
            }
          } else if (
            deltaType === "thought" ||
            deltaType === "thought_summary" ||
            deltaType === "raw_thought"
          ) {
            let thinkingText = "";
            if (typeof delta?.text === "string") {
              thinkingText = delta.text;
            } else if (typeof delta?.content === "string") {
              thinkingText = delta.content;
            } else if (Array.isArray(delta?.content)) {
              thinkingText = delta.content
                .map((content) => readStringField(asOptionalRecord(content), "text") ?? "")
                .join("");
            } else {
              thinkingText = readStringField(asOptionalRecord(delta?.content), "text") ?? "";
            }
            if (thinkingText) {
              if (currentBlockType !== "thinking") {
                endCurrentBlock();
                currentBlockType = "thinking";
                currentBlockIndex = output.content.length;
                output.content.push({
                  type: "thinking",
                  thinking: "",
                  ...(latestThoughtSignature ? { thinkingSignature: latestThoughtSignature } : {}),
                });
                stream.push({
                  type: "thinking_start",
                  contentIndex: currentBlockIndex,
                  partial: output,
                });
              }
              const block = output.content[currentBlockIndex];
              if (!block || block.type !== "thinking") {
                throw new Error("Google Interactions thought delta has no active thought block");
              }
              block.thinking += thinkingText;
              stream.push({
                type: "thinking_delta",
                contentIndex: currentBlockIndex,
                delta: thinkingText,
                partial: output,
              });
            }
          } else if (
            deltaType === "thought_signature" ||
            (delta && typeof delta.signature === "string" && !delta.text)
          ) {
            const signature = readStringField(delta, "signature") ?? "";
            if (signature) {
              latestThoughtSignature = signature;
              if (currentBlockType === "thinking") {
                const block = output.content[currentBlockIndex];
                if (block?.type === "thinking") {
                  block.thinkingSignature = signature;
                }
              } else {
                const lastThinking = output.content.findLast(
                  (block): block is ThinkingContent => block.type === "thinking",
                );
                if (lastThinking && !lastThinking.thinkingSignature) {
                  lastThinking.thinkingSignature = signature;
                } else if (!lastThinking) {
                  output.content.push({
                    type: "thinking",
                    thinking: "",
                    thinkingSignature: signature,
                  });
                }
              }
            }
          } else if (deltaType === "arguments" || deltaType === "arguments_delta") {
            const argText =
              readStringField(delta, "arguments") ?? readStringField(delta, "text") ?? "";
            if (currentBlockType !== "toolCall") {
              endCurrentBlock();
              currentBlockType = "toolCall";
              currentBlockIndex = output.content.length;
              const toolName = readStringField(delta, "name") ?? "tool";
              const toolCallId = readStringField(delta, "id") ?? nextToolCallId(toolName);
              currentToolCall = {
                type: "toolCall",
                id: toolCallId,
                name: toolName,
                arguments: {},
              };
              currentToolArgs = "";
              output.content.push(currentToolCall);
              stream.push({
                type: "toolcall_start",
                contentIndex: currentBlockIndex,
                partial: output,
              });
            }
            const streamedToolName = readStringField(delta, "name");
            if (
              streamedToolName &&
              currentToolCall &&
              (!currentToolCall.name || currentToolCall.name === "tool")
            ) {
              currentToolCall.name = streamedToolName;
            }
            const streamedToolCallId = readStringField(delta, "id");
            if (streamedToolCallId && currentToolCall) {
              currentToolCall.id = streamedToolCallId;
            }
            currentToolArgs += argText;
            stream.push({
              type: "toolcall_delta",
              contentIndex: currentBlockIndex,
              delta: argText,
              partial: output,
            });
          }
        } else if (eventType === "step.start") {
          const step = asOptionalRecord(event.step);
          if (step?.type === "thought") {
            const stepSignature = readStringField(step, "signature");
            if (stepSignature) {
              latestThoughtSignature = stepSignature;
            }
            let initialThinking = "";
            if (Array.isArray(step.summary)) {
              initialThinking = step.summary
                .map((content) => readStringField(asOptionalRecord(content), "text") ?? "")
                .join("");
            }
            if (currentBlockType !== "thinking") {
              endCurrentBlock();
              currentBlockType = "thinking";
              currentBlockIndex = output.content.length;
              output.content.push({
                type: "thinking",
                thinking: initialThinking,
                ...(latestThoughtSignature ? { thinkingSignature: latestThoughtSignature } : {}),
              });
              stream.push({
                type: "thinking_start",
                contentIndex: currentBlockIndex,
                partial: output,
              });
              if (initialThinking) {
                stream.push({
                  type: "thinking_delta",
                  contentIndex: currentBlockIndex,
                  delta: initialThinking,
                  partial: output,
                });
              }
            }
          } else if (step?.type === "model_output") {
            endCurrentBlock();
            currentBlockType = "text";
            currentBlockIndex = output.content.length;
            const initialText = Array.isArray(step.content)
              ? step.content
                  .map((content) => readStringField(asOptionalRecord(content), "text") ?? "")
                  .join("")
              : "";
            output.content.push({ type: "text", text: initialText });
            stream.push({
              type: "text_start",
              contentIndex: currentBlockIndex,
              partial: output,
            });
            if (initialText) {
              stream.push({
                type: "text_delta",
                contentIndex: currentBlockIndex,
                delta: initialText,
                partial: output,
              });
            }
          } else if (step?.type === "function_call") {
            endCurrentBlock();
            currentBlockType = "toolCall";
            currentBlockIndex = output.content.length;
            const toolName = readStringField(step, "name") ?? "tool";
            const toolCallId = readStringField(step, "id") ?? nextToolCallId(toolName);
            const stepArgs = asRecord(step.arguments);
            const initialArgs = Object.keys(stepArgs).length > 0 ? JSON.stringify(stepArgs) : "";
            currentToolCall = {
              type: "toolCall",
              id: toolCallId,
              name: toolName,
              arguments: stepArgs,
            };
            currentToolArgs = initialArgs;
            output.content.push(currentToolCall);
            stream.push({
              type: "toolcall_start",
              contentIndex: currentBlockIndex,
              partial: output,
            });
          }
        } else if (eventType === "step.stop") {
          latestUsage = asOptionalRecord(event.usage) ?? latestUsage;
          endCurrentBlock();
        } else if (eventType === "interaction.completed" || eventType === "interaction.complete") {
          sawCompletion = true;
          const interaction = asOptionalRecord(event.interaction) ?? event;
          const usage = asOptionalRecord(interaction.usage) ?? latestUsage ?? {};
          const promptTokens = Number(usage.total_input_tokens ?? 0);
          const cacheRead = Number(usage.total_cached_tokens ?? 0);
          const candidatesTokens = Number(usage.total_output_tokens ?? 0);
          const thoughtTokens = Number(usage.total_thought_tokens ?? 0);
          const toolUseTokens = Number(usage.total_tool_use_tokens ?? 0);
          const outputTokens = candidatesTokens + thoughtTokens;
          const totalTokens = Number(
            usage.total_tokens ?? promptTokens + outputTokens + toolUseTokens,
          );

          output.usage = {
            input: Math.max(0, promptTokens - cacheRead) + toolUseTokens,
            output: outputTokens,
            cacheRead,
            cacheWrite: 0,
            cacheTelemetry: { state: "available" },
            totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          if (model.cost) {
            calculateCost(model, output.usage);
          }

          const status = typeof interaction.status === "string" ? interaction.status : "completed";
          if (status === "failed" || status === "cancelled" || status === "budget_exceeded") {
            throw new Error(`Google Interactions API completed with status: ${status}`);
          }
          if (status === "incomplete") {
            output.stopReason = "length";
          } else {
            const hasToolCalls = output.content.some((b) => b.type === "toolCall");
            output.stopReason = hasToolCalls ? "toolUse" : "stop";
          }
        }
      }
    }

    if (streamDone) {
      void reader.cancel().catch(() => {});
    }

    endCurrentBlock();

    if (!sawCompletion) {
      throw new Error("Google Interactions stream ended before interaction.completed");
    }

    if (latestThoughtSignature) {
      for (const block of output.content) {
        if (block.type === "thinking" && !block.thinkingSignature) {
          block.thinkingSignature = latestThoughtSignature;
        }
      }
    }

    if (!output.stopReason) {
      const hasToolCalls = output.content.some((b) => b.type === "toolCall");
      output.stopReason = hasToolCalls ? "toolUse" : "stop";
    }

    if (output.stopReason === "aborted" || output.stopReason === "error") {
      throw new Error("An unknown error occurred");
    }

    stream.push({
      type: "done",
      reason: output.stopReason,
      message: output,
    });
    stream.end();
  } catch (error) {
    const failure = options?.signal?.aborted ? transportAbortError(options.signal) : error;
    assignTransportErrorDetails(output, failure, options?.signal);
    stream.push({
      type: "error",
      reason: output.stopReason === "aborted" ? "aborted" : "error",
      error: output,
    });
    stream.end();
  }
}
