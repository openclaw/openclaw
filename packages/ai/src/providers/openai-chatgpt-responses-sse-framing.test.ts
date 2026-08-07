import { _iterSSEMessages } from "openai/core/streaming";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  parseSSEForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "Explain the answer", timestamp: 1 }],
} satisfies Context;

function createAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-framing" } }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createSseResponse(chunks: readonly string[]): Response {
  const pending = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(next));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readPinnedSdkEvents(chunks: readonly string[]): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of _iterSSEMessages(createSseResponse(chunks), new AbortController())) {
    if (event.data !== "[DONE]") {
      events.push(JSON.parse(event.data) as Record<string, unknown>);
    }
  }
  return events;
}

async function readOwnerEvents(chunks: readonly string[]): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of parseSSEForTest(createSseResponse(chunks))) {
    events.push(event);
  }
  return events;
}

function completedPayload(id = "resp-framing"): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI ChatGPT Responses SSE framing", () => {
  it.each([
    {
      name: "existing LF events",
      chunks: [`data: ${completedPayload("resp-lf")}\n\n`],
      responseId: "resp-lf",
    },
    {
      name: "standard CRLF events",
      chunks: [`data: ${completedPayload("resp-crlf")}\r\n\r\n`],
      responseId: "resp-crlf",
    },
    {
      name: "standard CR events",
      chunks: [`data: ${completedPayload("resp-cr")}\r\r`],
      responseId: "resp-cr",
    },
    {
      name: "mixed valid line endings",
      chunks: [
        `: comment\r\nevent: response.completed\ndata: ${completedPayload("resp-mixed")}\r\n\n`,
      ],
      responseId: "resp-mixed",
    },
    {
      name: "CRLF boundaries split across transport chunks",
      chunks: [`data: ${completedPayload("resp-split-crlf")}\r`, "\n\r", "\n"],
      responseId: "resp-split-crlf",
    },
    {
      name: "CR boundaries split across transport chunks",
      chunks: [`data: ${completedPayload("resp-split-cr")}\r`, "\r"],
      responseId: "resp-split-cr",
    },
    {
      name: "multiline data fields and ignored metadata",
      chunks: [
        ': keepalive\r\nevent: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"id":"resp-multiline","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}\r\n\r\n',
      ],
      responseId: "resp-multiline",
    },
  ])(
    "matches the pinned SDK and completes actual production for $name",
    async ({ chunks, responseId }) => {
      const sdkEvents = await readPinnedSdkEvents(chunks);
      expect(sdkEvents).toHaveLength(1);
      expect(await readOwnerEvents(chunks)).toEqual(sdkEvents);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => createSseResponse(chunks)),
      );
      const result = await streamOpenAICodexResponses(model, context, {
        apiKey: createAccessToken(),
        transport: "sse",
        maxRetries: 0,
      }).result();

      expect(result).toMatchObject({ stopReason: "stop", responseId });
    },
  );

  it("dispatches a complete CR-delimited frame before the streaming body closes", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      }),
    );
    const iterator = parseSSEForTest(response)[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    controller?.enqueue(new TextEncoder().encode(`data: ${completedPayload("resp-open-cr")}\r`));
    controller?.enqueue(new TextEncoder().encode("\r"));

    try {
      const result = await Promise.race([
        nextEvent,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("complete CR-delimited frame was not dispatched")),
            100,
          );
        }),
      ]);
      expect(result.value).toMatchObject({ response: { id: "resp-open-cr" } });
    } finally {
      controller?.close();
      await iterator.return?.();
    }
  });

  it("preserves actionable malformed JSON diagnostics across CRLF frames", async () => {
    await expect(readOwnerEvents(['data: {"type":}\r\n\r\n'])).rejects.toThrow(
      "Invalid Codex SSE JSON",
    );
  });

  it("does not materialize an unterminated final event at EOF", async () => {
    const chunks = [`data: ${completedPayload("resp-unterminated")}`];
    expect(await readOwnerEvents(chunks)).toEqual(await readPinnedSdkEvents(chunks));
    expect(await readOwnerEvents(chunks)).toEqual([]);
  });
});
