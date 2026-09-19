import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { quoteUnsafeIntegerLiterals } from "openclaw/plugin-sdk/json-unsafe-integers";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import {
  createEmptyTransportUsage,
  failTransportStream,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import type { AppleFmNative } from "./native.js";

/** Native tools propose calls; the OpenClaw agent loop validates and executes them. */
export function createAppleFmStream(native: Pick<AppleFmNative, "run">): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createEmptyTransportUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    void (async () => {
      try {
        options?.signal?.throwIfAborted();
        const responseFormat = options?.responseFormat
          ? structuredClone(options.responseFormat)
          : undefined;
        const request = {
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: context.tools ?? [],
          maxTokens: options?.maxTokens ?? model.maxTokens,
          temperature: options?.temperature,
          responseFormat: responseFormat ? structuredClone(responseFormat) : undefined,
        };
        const payload = (await options?.onPayload?.(request, model)) ?? request;
        if (!payload || typeof payload !== "object") {
          throw new Error("Apple Foundation Models requires an object request.");
        }
        options?.signal?.throwIfAborted();
        const result = await native.run(payload, { signal: options?.signal });
        options?.signal?.throwIfAborted();
        if (responseFormat && result.toolCalls.length === 0) {
          const unsafeNumberMessage =
            "Apple Foundation Models returned an invalid structured response: an unsafe numeric value cannot be validated without losing precision.";
          if (quoteUnsafeIntegerLiterals(result.text) !== result.text) {
            throw new Error(unsafeNumberMessage);
          }
          let value: unknown;
          try {
            value = JSON.parse(result.text, (_key, parsedValue: unknown) => {
              // The literal detector excludes exponent forms; preserve numeric types while checking them too.
              if (
                typeof parsedValue === "number" &&
                (!Number.isFinite(parsedValue) ||
                  (Number.isInteger(parsedValue) && !Number.isSafeInteger(parsedValue)))
              ) {
                throw new Error(unsafeNumberMessage);
              }
              return parsedValue;
            });
          } catch (error) {
            if (!(error instanceof SyntaxError)) {
              throw error;
            }
          }
          // JSON cannot encode undefined; discard syntax errors that may contain model response text.
          if (value === undefined) {
            throw new Error(
              "Apple Foundation Models returned an invalid structured response: malformed JSON.",
            );
          }
          const validation = validateJsonSchemaValue({
            schema: responseFormat,
            cacheKey: "apple-fm.structured-response",
            value,
            applyDefaults: false,
          });
          if (!validation.ok) {
            throw new Error(
              `Apple Foundation Models returned an invalid structured response at ${validation.errors.map((error) => error.path).join(", ")}.`,
            );
          }
        }
        message.usage.input = result.inputTokens;
        message.usage.output = result.outputTokens;
        message.usage.totalTokens = result.inputTokens + result.outputTokens;
        message.usage.cacheTelemetry = { state: "unavailable" };
        message.usage.contextUsage = {
          state: "available",
          promptTokens: result.inputTokens,
          totalTokens: message.usage.totalTokens,
        };
        if (result.text) {
          message.content.push({ type: "text", text: result.text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: result.text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: result.text,
            partial: message,
          });
        }
        for (const call of result.toolCalls) {
          const toolCall = { type: "toolCall" as const, ...call };
          const contentIndex = message.content.length;
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(call.arguments),
            partial: message,
          });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        }
        message.stopReason = result.toolCalls.length ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      } catch (error) {
        failTransportStream({ stream, output: message, error, signal: options?.signal });
      }
    })();
    return stream;
  };
}
