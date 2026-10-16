import { createServer, type RequestListener } from "node:http";
import { expect, it } from "vitest";
import {
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
  expectOpenAITransportRequestPolicy,
} from "../../../../test/helpers/openai-transport-request-policy.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import { streamSimpleOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessage, SimpleStreamOptions } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";
import { collectEventTypes, userMessage } from "./openai-stream-cases.test-support.js";

async function withServer(handler: RequestListener, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const tools = [
  { id: "call_weather", name: "weather", arguments: { city: "Vienna" } },
  { id: "call_time", name: "time", arguments: { zone: "UTC" } },
];
const wireTools = tools.map(({ id, name, arguments: args }) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
}));
const context = { systemPrompt: "system", messages: [userMessage("Reply live-ok")], tools: [] };
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const providerError = {
  message: "Quota exceeded for api_key=sk-secret1234567890abcd",
  type: "rate_limit_error",
  code: "insufficient_quota",
};

it(
  "honors turn timeout and pinned SDK retries over real HTTP",
  () =>
    expectOpenAITransportRequestPolicy({
      api: "openai-completions",
      provider: "openai",
      createStream: createOpenAICompletionsTransportStreamFn,
    }),
  COLD_RUNNER_HTTP_TEST_TIMEOUT_MS,
);
it("preserves OpenAI-compatible error metadata on failed chat requests", async () => {
  await withServer(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(429, jsonHeaders);
        res.end(JSON.stringify({ error: providerError }));
      });
    },
    async (baseUrl) => {
      const model = makeCompletionsModel({ id: "gpt-5.4-mini", baseUrl });
      const stream = await createOpenAICompletionsTransportStreamFn()(model, context, {
        apiKey: "test-key",
      });
      expect(await collectEventTypes(stream)).toEqual(["error"]);
      const errorPayload = await stream.result();

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
      (req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          capturedRequests.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200, jsonHeaders);
          const responseBody = oversized
            ? " ".repeat(16 * 1024 * 1024 + 1)
            : JSON.stringify({
                id: "chatcmpl-json-fallback",
                choices: [
                  {
                    message: {
                      role: "assistant",
                      reasoning_content: "Need a direct answer.",
                      content: "live-ok",
                      ...(includeTools ? { tool_calls: wireTools } : {}),
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
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({
          id: "moonshotai/kimi-k2.6",
          provider: "openrouter",
          baseUrl,
          compat: {
            supportsReasoningEffort: true,
          },
        });
        const createStream =
          mode === "managed"
            ? createOpenAICompletionsTransportStreamFn()
            : streamSimpleOpenAICompletions;
        const requestOptions = (
          streaming?: boolean,
          reasoning?: "high",
        ): SimpleStreamOptions & Pick<OpenAICompletionsOptions, "streaming"> => ({
          apiKey: "test-key",
          streaming,
          reasoning,
          onResponse: () => releaseBody?.(),
        });
        for (const [modelStreaming, streaming, expected, withTools] of [
          [undefined, undefined, true, false],
          [false, undefined, false, false],
          [undefined, false, false, true],
          [false, true, true, true],
        ] as const) {
          includeTools = withTools;
          const stream = await createStream(
            { ...model, params: { streaming: modelStreaming } },
            context,
            requestOptions(streaming, "high"),
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
          expect(request?.stream).toBe(expected);
          if (expected) {
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
              ? tools.map((tool) => expect.objectContaining({ type: "toolCall", ...tool }))
              : []),
          ]);
          expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(
            includeTools ? 2 : 0,
          );
        }
        oversized = true;
        const oversizedStream = await createStream(model, context, requestOptions(false));
        expect(await oversizedStream.result()).toMatchObject({
          stopReason: "error",
          errorMessage: expect.stringContaining("JSON response exceeds 16777216 bytes"),
        });
      },
    );
  },
);
