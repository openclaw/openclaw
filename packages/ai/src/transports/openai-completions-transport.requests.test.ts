import { describe, expect, it } from "vitest";
import {
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  expectOpenAITransportRequestPolicy,
} from "../../../../test/helpers/openai-transport-request-policy.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import type { SimpleStreamOptions } from "../types.js";
import {
  collectStream,
  replyContext,
  withServer,
} from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const toolCalls = [
  { name: "weather", arguments: { city: "Vienna" } },
  { name: "time", arguments: { zone: "UTC" } },
];

describe("openai completions transport requests", () => {
  it.each([
    {
      api: "openai-completions" as const,
      provider: "openai",
      createStream: createOpenAICompletionsTransportStreamFn,
    },
  ])(
    "honors turn timeout and pinned SDK retries over real $api HTTP",
    expectOpenAITransportRequestPolicy,
    COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  );
  it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "req_error_metadata",
        });
        res.end(
          JSON.stringify({
            error: {
              message: "Quota exceeded for api_key=sk-secret1234567890abcd",
              type: "rate_limit_error",
              code: "insufficient_quota",
            },
          }),
        );
      },
      async (baseUrl) => {
        const { terminal } = await collectStream(
          createOpenAICompletionsTransportStreamFn()(
            makeCompletionsModel({ id: "gpt-5.4-mini", baseUrl }),
            replyContext(),
            { apiKey: "test-key" },
          ),
        );
        const errorPayload = terminal?.type === "error" ? terminal.error : undefined;

        expect(errorPayload).toMatchObject({
          stopReason: "error",
          errorCode: "insufficient_quota",
          errorType: "rate_limit_error",
        });
        expect(String(errorPayload?.errorBody)).toContain("Quota exceeded");
        expect(String(errorPayload?.errorBody)).not.toContain("sk-secret1234567890abcd");
      },
    );
  });

  it.each(["managed", "direct"] as const)(
    "preserves JSON completions and honors streaming controls (%s)",
    async (mode) => {
      const capturedRequests: Array<Record<string, unknown>> = [];
      let includeTools = false;
      let oversized = false;
      let releaseBody: (() => void) | undefined;
      await withServer(
        (_req, res, body) => {
          capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
          });
          const responseBody = oversized
            ? " ".repeat(16 * 1024 * 1024 + 1)
            : JSON.stringify({
                id: "chatcmpl-json-fallback",
                object: "chat.completion",
                model: "moonshotai/kimi-k2.6",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      reasoning_content: "Need a direct answer.",
                      content: "live-ok",
                      ...(includeTools
                        ? {
                            tool_calls: toolCalls.map(({ name, arguments: args }) => ({
                              id: `call_${name}`,
                              type: "function",
                              function: { name, arguments: JSON.stringify(args) },
                            })),
                          }
                        : {}),
                    },
                    finish_reason: includeTools ? "tool_calls" : "stop",
                  },
                ],
                usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
              });
          if (capturedRequests.at(-1)?.stream === false) {
            releaseBody = () => res.end(responseBody);
            res.flushHeaders();
          } else {
            releaseBody = undefined;
            res.end(responseBody);
          }
        },
        async (baseUrl) => {
          const model = makeCompletionsModel({
            id: "moonshotai/kimi-k2.6",
            name: "Kimi K2.6",
            provider: "openrouter",
            baseUrl,
            contextWindow: 256_000,
            maxTokens: 16_384,
            compat: {
              supportsReasoningEffort: true,
            },
          });
          const createStream =
            mode === "managed"
              ? createOpenAICompletionsTransportStreamFn()
              : streamSimpleOpenAICompletions;
          for (const scenario of [
            { params: {}, options: {}, expected: true, tools: false },
            { params: { streaming: false }, options: {}, expected: false, tools: false },
            { params: {}, options: { streaming: false }, expected: false, tools: true },
            {
              params: { streaming: false },
              options: { streaming: true },
              expected: true,
              tools: true,
            },
          ]) {
            includeTools = scenario.tools;
            const options: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "streaming"> = {
              apiKey: "test-key",
              reasoning: "high",
              ...scenario.options,
              onResponse: () => {
                releaseBody?.();
              },
            };
            const stream = await createStream(
              { ...model, params: scenario.params },
              replyContext("Reply live-ok"),
              options,
            );
            const { result: final, events } = await collectStream(stream);
            const eventTypes = events.map((event) => event.type);
            const request = capturedRequests.at(-1);
            expect(request?.stream).toBe(scenario.expected);
            if (scenario.expected) {
              expect(request?.stream_options).toEqual({ include_usage: true });
            } else {
              expect(request).not.toHaveProperty("stream_options");
            }
            expect(eventTypes).toContain("text_delta");
            expect(eventTypes).toContain("thinking_delta");
            expect(eventTypes[0]).toBe("start");
            expect(eventTypes.at(-1)).toBe("done");
            expect(final).toMatchObject({
              responseId: "chatcmpl-json-fallback",
              stopReason: includeTools ? "toolUse" : "stop",
              usage: { input: 2, output: 3, totalTokens: 5 },
            });
            expect(final?.content).toEqual([
              expect.objectContaining({
                type: "thinking",
                thinking: "Need a direct answer.",
                thinkingSignature: "reasoning_content",
              }),
              expect.objectContaining({ type: "text", text: "live-ok" }),
              ...(includeTools
                ? toolCalls.map((call) =>
                    expect.objectContaining({
                      type: "toolCall",
                      id: `call_${call.name}`,
                      ...call,
                    }),
                  )
                : []),
            ]);
            expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(
              includeTools ? 2 : 0,
            );
          }
          oversized = true;
          const options: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "streaming"> = {
            apiKey: "test-key",
            streaming: false,
            onResponse: () => {
              releaseBody?.();
            },
          };
          const oversizedStream = await createStream(
            model,
            { messages: replyContext().messages },
            options,
          );
          expect(await oversizedStream.result()).toMatchObject({
            stopReason: "error",
            errorMessage: expect.stringContaining("JSON response exceeds 16777216 bytes"),
          });
        },
      );
    },
  );
});
