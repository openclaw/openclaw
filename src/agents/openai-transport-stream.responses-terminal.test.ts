import { createServer } from "node:http";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";
import { makeResponsesModel } from "./openai-transport-stream.test-harness.js";

type ObservedResponsesEvent = {
  type: string;
  reason?: string;
  delta?: string;
  message?: {
    stopReason?: string;
    responseId?: string;
    usage?: { input?: number; output?: number; totalTokens?: number };
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: {
    stopReason?: string;
    responseId?: string;
    errorMessage?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

async function streamResponsesOverLoopback(
  responseEvents: readonly Record<string, unknown>[],
  options: { sendDone?: boolean } = {},
): Promise<{ path: string | undefined; events: ObservedResponsesEvent[] }> {
  const captured: { path: string | undefined } = { path: undefined };
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      captured.path = request.url;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      for (const event of responseEvents) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (options.sendDone) {
        response.write("data: [DONE]\n\n");
      }
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing Responses loopback server address");
    }
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    const stream = createOpenAIResponsesTransportStreamFn()(
      model,
      {
        messages: [{ role: "user", content: "Reply hello", timestamp: Date.now() }],
      } as never,
      { apiKey: "test-loopback-key" } as never,
    );

    const events: ObservedResponsesEvent[] = [];
    for await (const event of stream as AsyncIterable<ObservedResponsesEvent>) {
      events.push(event);
    }
    return { path: captured.path, events };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("OpenAI Responses HTTP stream terminal events", () => {
  it.each([
    {
      label: "an empty SSE response",
      events: [],
      sendDone: false,
    },
    {
      label: "a created-only response",
      events: [{ type: "response.created", response: { id: "resp_truncated_created" } }],
      sendDone: false,
    },
    {
      label: "partial assistant text",
      events: [
        { type: "response.created", response: { id: "resp_truncated_text" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_truncated", role: "assistant" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_truncated",
          delta: "partial answer",
        },
      ],
      sendDone: false,
    },
    {
      label: "an SSE DONE marker without a Responses terminal event",
      events: [{ type: "response.created", response: { id: "resp_truncated_done" } }],
      sendDone: true,
    },
  ])("fails closed when $label reaches EOF", async ({ events, sendDone }) => {
    const result = await streamResponsesOverLoopback(events, { sendDone });

    expect(result.path).toBe("/v1/responses");
    expect(result.events.filter((event) => event.type === "done")).toEqual([]);
    expect(result.events.find((event) => event.type === "error")?.error).toMatchObject({
      stopReason: "error",
      errorMessage: "OpenAI Responses stream ended before a terminal response event",
    });
  });

  it("preserves complete HTTP responses and terminal usage without an SSE DONE marker", async () => {
    const result = await streamResponsesOverLoopback([
      { type: "response.created", response: { id: "resp_http_completed" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_http_completed", role: "assistant" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "msg_http_completed",
        delta: "hello",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_http_completed",
          status: "completed",
          output: [],
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        },
      },
    ]);

    expect(result.path).toBe("/v1/responses");
    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      reason: "stop",
      message: {
        responseId: "resp_http_completed",
        stopReason: "stop",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 7, output: 3, totalTokens: 10 },
      },
    });
  });

  it("preserves incomplete HTTP responses and terminal usage", async () => {
    const result = await streamResponsesOverLoopback([
      { type: "response.created", response: { id: "resp_http_incomplete" } },
      {
        type: "response.incomplete",
        response: {
          id: "resp_http_incomplete",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              id: "msg_http_incomplete",
              role: "assistant",
              content: [{ type: "output_text", text: "partial hello" }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      },
    ]);

    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(result.events.find((event) => event.type === "done")).toMatchObject({
      reason: "length",
      message: {
        responseId: "resp_http_incomplete",
        stopReason: "length",
        content: [{ type: "text", text: "partial hello" }],
        usage: { input: 5, output: 2, totalTokens: 7 },
      },
    });
  });

  it("preserves genuine failed HTTP response diagnostics", async () => {
    const result = await streamResponsesOverLoopback([
      { type: "response.created", response: { id: "resp_http_failed" } },
      {
        type: "response.failed",
        response: {
          id: "resp_http_failed",
          status: "failed",
          error: { code: "server_error", message: "upstream response failed" },
        },
      },
    ]);

    expect(result.events.filter((event) => event.type === "done")).toEqual([]);
    expect(result.events.find((event) => event.type === "error")?.error).toMatchObject({
      responseId: "resp_http_failed",
      stopReason: "error",
      errorMessage: "server_error: upstream response failed",
    });
  });
});
