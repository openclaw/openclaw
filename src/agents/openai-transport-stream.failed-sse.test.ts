import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";
import { isRetryableAssistantError, isTerminalAssistantError } from "../llm/utils/retry.js";
import { makeResponsesModel } from "./openai-transport-stream.test-harness.js";

const responsesTransports = [
  {
    api: "openai-responses" as const,
    provider: "openai",
    createStream: createOpenAIResponsesTransportStreamFn,
  },
  {
    api: "azure-openai-responses" as const,
    provider: "azure-openai",
    createStream: createAzureOpenAIResponsesTransportStreamFn,
  },
] as const;

const usage = {
  input_tokens: 21,
  output_tokens: 4,
  total_tokens: 25,
  input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
};
type Transport = (typeof responsesTransports)[number];
function responseStream(
  transport: Transport,
  baseUrl: string,
  prompt: string,
  options: Parameters<ReturnType<Transport["createStream"]>>[2] = {},
  model: Parameters<typeof makeResponsesModel>[0] = {},
) {
  return transport.createStream()(
    makeResponsesModel({ api: transport.api, provider: transport.provider, baseUrl, ...model }),
    { messages: [{ role: "user", content: prompt, timestamp: 0 }], tools: [] },
    { apiKey: "test-key", ...options },
  );
}

async function createResponsesSseServer(...events: Record<string, unknown>[]): Promise<{
  server: Server;
  baseUrl: string;
  requestPaths: string[];
}> {
  const requestPaths: string[] = [];
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const event of events) {
        response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing Responses loopback server address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestPaths };
}

async function closeResponsesSseServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("failed Responses loopback SSE", () => {
  it.each(
    responsesTransports.flatMap((transport) =>
      [false, true].map((hostedTools) => ({ transport, hostedTools })),
    ),
  )(
    "preserves $transport.api identity diagnostics and request retry safety (hosted tools: $hostedTools)",
    async ({ transport, hostedTools }) => {
      const { server, baseUrl } = await createResponsesSseServer(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_private_canary", summary: [] },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_conflicting",
            status: "completed",
            output: [{ type: "message", id: "msg_private_canary", content: [] }],
          },
        },
      );
      try {
        const stream = await responseStream(transport, baseUrl, "Reply", {
          onPayload: hostedTools
            ? () => ({
                model: "test-model",
                input: "Reply",
                stream: true,
                tools: [{ type: "web_search" }],
              })
            : undefined,
        });
        const message = await stream.result();
        expect(message).toMatchObject({
          stopReason: "error",
          errorCode: "responses_output_identity_conflict",
          errorMessage: "Responses stream changed output item identity",
        });
        expect(JSON.parse(message.errorBody ?? "{}")).toEqual({
          outputIndex: 0,
          expectedType: "reasoning",
          actualType: "message",
          completed: false,
          completedToolCall: false,
          mismatch: "type",
          eventType: "response.completed",
          retrySafe: !hostedTools,
        });
        expect(message.errorBody).not.toContain("private_canary");
        expect(isRetryableAssistantError(message)).toBe(!hostedTools);
        expect(isTerminalAssistantError(message)).toBe(hostedTools);
      } finally {
        await closeResponsesSseServer(server);
      }
    },
  );
  it.each(responsesTransports)(
    "preserves failed $api terminal facts over the real SDK stream",
    async (transport) => {
      const { server, baseUrl, requestPaths } = await createResponsesSseServer({
        type: "response.failed",
        sequence_number: 0,
        response: {
          id: "resp-failed-usage-sse",
          model: "gpt-5.6-luna",
          status: "failed",
          error: { code: "server_error", message: "provider failed after consuming tokens" },
          output: [],
          usage: {
            ...usage,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });

      try {
        const stream = await responseStream(
          transport,
          baseUrl,
          "Report failed usage",
          {},
          {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        );
        const events = [];
        for await (const event of stream) {
          events.push(event);
        }

        expect(requestPaths).toHaveLength(1);
        expect(requestPaths[0]).toMatch(/^\/v1\/responses(?:\?|$)/);
        expect(events.map((event) => event.type)).toEqual(["start", "error"]);
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({
          type: "error",
          reason: "error",
          error: {
            responseId: "resp-failed-usage-sse",
            responseModel: "gpt-5.6-luna",
            stopReason: "error",
            errorMessage: "server_error: provider failed after consuming tokens",
            // Preserve structured classification instead of folding it into timeout (#117609).
            errorCode: "server_error",
            usage: {
              input: 13,
              output: 4,
              cacheRead: 6,
              cacheWrite: 2,
              reasoningTokens: 3,
              totalTokens: 25,
            },
          },
        });
        if (terminal?.type === "error") {
          expect(terminal.error.usage.cost.input).toBeCloseTo(0.000065, 10);
          expect(terminal.error.usage.cost.output).toBeCloseTo(0.00012, 10);
          expect(terminal.error.usage.cost.cacheRead).toBeCloseTo(0.000003, 10);
          expect(terminal.error.usage.cost.cacheWrite).toBeCloseTo(0.0000125, 10);
          expect(terminal.error.usage.cost.total).toBeCloseTo(0.0002005, 10);
        }
      } finally {
        await closeResponsesSseServer(server);
      }
    },
  );
});

describe("incomplete Responses loopback SSE", () => {
  it.each([
    {
      api: "openai-responses" as const,
      provider: "openai",
      createStream: createOpenAIResponsesTransportStreamFn,
    },
  ])("recovers status-less incomplete $api output over real SSE", async (transport) => {
    const { server, baseUrl, requestPaths } = await createResponsesSseServer({
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        id: "resp-statusless-sse",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            id: "msg-statusless-sse",
            role: "assistant",
            content: [{ type: "output_text", text: "TERMINAL_PARTIAL" }],
          },
          {
            type: "function_call",
            id: "fc-statusless-sse",
            call_id: "call-statusless-sse",
            name: "write",
            arguments: '{"path":"unfinished',
          },
        ],
        usage,
      },
    });
    try {
      const stream = await responseStream(
        transport,
        baseUrl,
        "Reply with a partial sentence",
        {},
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      );
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      const terminal = events.find((event) => event.type === "done");
      expect(requestPaths).toHaveLength(1);
      expect(requestPaths[0]).toMatch(/^\/v1\/responses(?:\?|$)/);
      expect(terminal).toMatchObject({
        type: "done",
        reason: "length",
        message: {
          stopReason: "length",
          content: [{ type: "text", text: "TERMINAL_PARTIAL" }],
          usage: {
            input: 13,
            output: 4,
            cacheRead: 6,
            cacheWrite: 2,
            totalTokens: 25,
          },
        },
      });
      if (terminal?.type === "done") {
        expect(terminal.message.content.some((block) => block.type === "toolCall")).toBe(false);
      }
    } finally {
      await closeResponsesSseServer(server);
    }
  });
});
