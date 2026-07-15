import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Usage } from "../types.js";
import { streamSimpleOpenAIResponses } from "./openai-responses.js";

type CapturedRequest = {
  path: string;
  body: Record<string, unknown>;
};

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRequest[],
) => void | Promise<void>;

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(baseUrl: string): Model<"openai-responses"> {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function priorAssistant(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    content: [
      {
        type: "thinking",
        thinking: "old private reasoning",
        thinkingSignature: JSON.stringify({
          id: "rs_stale",
          type: "reasoning",
          summary: [],
          encrypted_content: "ciphertext-must-not-be-retried",
        }),
      },
      {
        type: "text",
        text: "old answer",
        textSignature: JSON.stringify({ v: 1, id: "msg_stale" }),
      },
      {
        type: "toolCall",
        id: "call_keep|fc_keep",
        name: "lookup",
        arguments: { q: "preserve me" },
      },
    ],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

function replayContext(): Context {
  return {
    systemPrompt: "Be concise.",
    messages: [
      { role: "user", content: "first", timestamp: 0 },
      priorAssistant(),
      {
        role: "toolResult",
        toolCallId: "call_keep|fc_keep",
        toolName: "lookup",
        content: [{ type: "text", text: "tool result" }],
        isError: false,
        timestamp: 2,
      },
      { role: "user", content: "next", timestamp: 3 },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } as never }],
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function withLoopbackServer(handler: Handler): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      requests.push({ path: request.url ?? "", body: await readJsonBody(request) });
      await handler(request, response, requests);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writePlainError(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}

function writeSse(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function failedEvent(code = "invalid_encrypted_content"): Record<string, unknown> {
  return {
    type: "response.failed",
    response: {
      id: "resp_failed",
      status: "failed",
      error: { code, message: "stale encrypted_content could not be verified" },
    },
  };
}

function successEvents(text = "ok"): Record<string, unknown>[] {
  return [
    { type: "response.created", response: { id: "resp_ok", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_ok",
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_ok",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_ok",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_ok",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_ok",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      },
    },
  ];
}

function visibleThenFailedEvents(): Record<string, unknown>[] {
  return [
    { type: "response.created", response: { id: "resp_partial", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_partial",
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_partial",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_partial",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    },
    failedEvent(),
  ];
}

async function collectEvents(
  baseUrl: string,
  options: Record<string, unknown> = {},
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const streamOptions = {
    apiKey: "test-key",
    maxRetries: 0,
    reasoning: "low" as const,
    replayResponsesItemIds: true,
    ...options,
  } as Parameters<typeof streamSimpleOpenAIResponses>[2] & { replayResponsesItemIds: true };
  const stream = streamSimpleOpenAIResponses(model(baseUrl), replayContext(), streamOptions);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, result: await stream.result() };
}

function addCompactionReplayItem(payload: unknown): unknown {
  const request = payload as { input?: unknown[] };
  request.input = [
    { type: "compaction", encrypted_content: "stale-compaction-ciphertext" },
    ...(request.input ?? []),
  ];
  return request;
}

function hasObjectKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasObjectKey(item, key));
  }
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || hasObjectKey(entryValue, key),
  );
}

function inputItems(request: CapturedRequest): Record<string, unknown>[] {
  return (request.body.input as Record<string, unknown>[] | undefined) ?? [];
}

function requestAt(requests: CapturedRequest[], index: number): CapturedRequest {
  const request = requests[index];
  if (!request) {
    throw new Error(`Missing captured request at index ${index}`);
  }
  return request;
}

afterEach(() => {
  configureAiTransportHost({});
});

describe("streamSimpleOpenAIResponses invalid encrypted content recovery", () => {
  it("recovers once from an HTTP 400 plain-text create error with a sanitized replay payload", async () => {
    const server = await withLoopbackServer((_request, response, requests) => {
      if (requests.length === 1) {
        writePlainError(
          response,
          400,
          "invalid_encrypted_content: stale encrypted_content could not be decrypted",
        );
        return;
      }
      writeSse(response, successEvents("ok"));
    });

    try {
      const { events, result } = await collectEvents(server.baseUrl, {
        onPayload: addCompactionReplayItem,
      });

      expect(result.stopReason).toBe("stop");
      expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
      expect(events.filter((event) => event.type === "start")).toHaveLength(1);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(server.requests).toHaveLength(2);

      const firstRequest = requestAt(server.requests, 0);
      const retryRequest = requestAt(server.requests, 1);
      const firstInput = inputItems(firstRequest);
      const retryInput = inputItems(retryRequest);
      expect(firstInput.some((item) => item.type === "reasoning")).toBe(true);
      expect(firstInput.some((item) => item.type === "compaction")).toBe(true);
      expect(retryInput.some((item) => item.type === "reasoning")).toBe(false);
      expect(retryInput.some((item) => item.type === "compaction")).toBe(false);
      expect(hasObjectKey(retryRequest.body, "encrypted_content")).toBe(false);
      expect(
        retryInput.find((item) => item.type === "message" && item.role === "assistant"),
      ).not.toHaveProperty("id");
      expect(retryInput.some((item) => item.type === "function_call")).toBe(true);
      expect(retryInput.some((item) => item.type === "function_call_output")).toBe(true);
      expect(retryRequest.body.tools).toEqual(firstRequest.body.tools);
    } finally {
      await server.close();
    }
  });

  it("recovers once from a pre-output SSE response.failed invalid_encrypted_content event", async () => {
    const server = await withLoopbackServer((_request, response, requests) => {
      writeSse(response, requests.length === 1 ? [failedEvent()] : successEvents("ok"));
    });

    try {
      const { events, result } = await collectEvents(server.baseUrl);

      expect(result.stopReason).toBe("stop");
      expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
      expect(server.requests).toHaveLength(2);
      expect(events.map((event) => event.type)).toEqual([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ]);
      expect(
        inputItems(requestAt(server.requests, 1)).some((item) => item.type === "reasoning"),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("does not retry non-target create errors", async () => {
    const server = await withLoopbackServer((_request, response) => {
      writePlainError(response, 400, "bad_request: ordinary validation failure");
    });

    try {
      const { result } = await collectEvents(server.baseUrl);

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("ordinary validation failure");
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("does not retry a target SSE failure after visible output has been emitted", async () => {
    const server = await withLoopbackServer((_request, response) => {
      writeSse(response, visibleThenFailedEvents());
    });

    try {
      const { events, result } = await collectEvents(server.baseUrl);

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("invalid_encrypted_content");
      expect(result.content).toMatchObject([{ type: "text", text: "partial" }]);
      expect(events.some((event) => event.type === "text_delta")).toBe(true);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("bounds recovery to one retry and surfaces the second target failure", async () => {
    const server = await withLoopbackServer((_request, response) => {
      writePlainError(response, 400, "thinking_signature_invalid: still stale");
    });

    try {
      const { result } = await collectEvents(server.baseUrl);

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("thinking_signature_invalid");
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});
