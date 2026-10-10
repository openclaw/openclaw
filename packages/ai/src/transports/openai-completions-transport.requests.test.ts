import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const COLD_RUNNER_HTTP_TEST_TIMEOUT_MS = 300_000;

describe("openai completions transport requests", () => {
  it.each([
    {
      api: "openai-completions" as const,
      provider: "openai",
      createStream: createOpenAICompletionsTransportStreamFn,
    },
  ])(
    "honors turn timeout and pinned SDK retries over real $api HTTP",
    async (transport) => {
      const capturedTimeouts: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        const timeout = request.headers["x-stainless-timeout"];
        capturedTimeouts.push(Array.isArray(timeout) ? timeout[0] : timeout);
        request.resume();
        request.on("end", () => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { type: "server_error", message: "turn retry regression" },
            }),
          );
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }

        const model = {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          api: transport.api,
          provider: transport.provider,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
          requestTimeoutMs: 900_000,
        } satisfies Model & { requestTimeoutMs: number };

        const stream = await transport.createStream()(
          model,
          {
            messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
            tools: [],
          },
          { apiKey: "test-key", timeoutMs: 1_234 },
        );

        const eventTypes: string[] = [];
        for await (const event of stream) {
          eventTypes.push(event.type);
        }

        expect(eventTypes).toContain("error");
        // The SDK advertises request timeouts in whole seconds on the wire.
        expect(capturedTimeouts).toEqual(["1"]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  );
  it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
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
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = createOpenAICompletionsTransportStreamFn()(
        model,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let errorPayload: Record<string, unknown> | undefined;
      for await (const event of stream as AsyncIterable<{
        type: string;
        error?: Record<string, unknown>;
      }>) {
        if (event.type === "error") {
          errorPayload = event.error;
        }
      }

      expect(errorPayload).toMatchObject({
        stopReason: "error",
        errorCode: "insufficient_quota",
        errorType: "rate_limit_error",
      });
      expect(String(errorPayload?.errorBody)).toContain("Quota exceeded");
      expect(String(errorPayload?.errorBody)).not.toContain("sk-secret1234567890abcd");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["managed", "direct"] as const)(
    "preserves JSON completions and honors streaming controls (%s)",
    async (mode) => {
      const capturedRequests: Array<Record<string, unknown>> = [];
      let includeTools = false;
      let oversized = false;
      let releaseBody: (() => void) | undefined;
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
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
                            tool_calls: [
                              {
                                id: "call_weather",
                                type: "function",
                                function: { name: "weather", arguments: '{"city":"Vienna"}' },
                              },
                              {
                                id: "call_time",
                                type: "function",
                                function: { name: "time", arguments: '{"zone":"UTC"}' },
                              },
                            ],
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
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing loopback server address");
        }
        const model = makeCompletionsModel({
          id: "moonshotai/kimi-k2.6",
          name: "Kimi K2.6",
          provider: "openrouter",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
            {
              systemPrompt: "system",
              messages: [{ role: "user", content: "Reply live-ok", timestamp: 1 }],
              tools: [],
            },
            options,
          );
          let final: AssistantMessage | undefined;
          const eventTypes: string[] = [];
          for await (const event of stream) {
            eventTypes.push(event.type);
            if (event.type === "done") {
              final = event.message;
            }
          }
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
              ? [
                  expect.objectContaining({
                    type: "toolCall",
                    id: "call_weather",
                    name: "weather",
                    arguments: { city: "Vienna" },
                  }),
                  expect.objectContaining({
                    type: "toolCall",
                    id: "call_time",
                    name: "time",
                    arguments: { zone: "UTC" },
                  }),
                ]
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
          {
            messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
          },
          options,
        );
        expect(await oversizedStream.result()).toMatchObject({
          stopReason: "error",
          errorMessage: expect.stringContaining("JSON response exceeds 16777216 bytes"),
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
