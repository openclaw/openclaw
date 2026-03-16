import type { Context } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIResponsesHttpStreamFn } from "./openai-responses-http-stream.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Encode an SSE event into `data: ...\n\n` format. */
function sseEvent(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Build a minimal model descriptor for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function testModel(overrides?: Record<string, unknown>): any {
  return {
    id: "test-model",
    api: "openai-responses",
    provider: "custom-test",
    name: "Test Model",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
    ...overrides,
  };
}

/** Build a minimal context with a single user message. */
function testContext(overrides?: Partial<Context>): Context {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    systemPrompt: "You are helpful.",
    ...overrides,
  } as Context;
}

/** Collect all events from a stream (handles sync or async iterable). */
async function collectEvents(
  stream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
): Promise<unknown[]> {
  const resolved = await stream;
  const events: unknown[] = [];
  for await (const event of resolved) {
    events.push(event);
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("openai-responses-http-stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams text deltas and completes with assistant message", async () => {
    const sseBody =
      sseEvent({ type: "response.created", response: { id: "resp_1", status: "in_progress" } }) +
      sseEvent({ type: "response.output_text.delta", delta: "Hello " }) +
      sseEvent({ type: "response.output_text.delta", delta: "world!" }) +
      sseEvent({
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          created_at: 1700000000,
          status: "completed",
          model: "test-model",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello world!" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
    });

    const events = (await collectEvents(streamFn(testModel(), testContext(), {}))) as Array<{
      type: string;
      delta?: string;
    }>;

    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_delta");
    expect(types).toContain("done");

    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas).toEqual(["Hello ", "world!"]);

    const doneEvent = events.find((e) => e.type === "done") as {
      type: string;
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(doneEvent.message.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "Hello world!" })]),
    );
  });

  it("handles tool calls in the response", async () => {
    const sseBody = sseEvent({
      type: "response.completed",
      response: {
        id: "resp_2",
        object: "response",
        created_at: 1700000000,
        status: "completed",
        model: "test-model",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
    });

    const events = (await collectEvents(streamFn(testModel(), testContext(), {}))) as Array<{
      type: string;
      reason?: string;
      message?: { stopReason: string; content: Array<{ type: string; name?: string }> };
    }>;

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.reason).toBe("toolUse");
    expect(doneEvent!.message!.stopReason).toBe("toolUse");
    expect(doneEvent!.message!.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "toolCall", name: "get_weather" })]),
    );
  });

  it("emits error on HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "bad-key",
      baseUrl: "https://api.example.com/v1",
    });

    const events = (await collectEvents(streamFn(testModel(), testContext(), {}))) as Array<{
      type: string;
    }>;

    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("emits error on response.failed event", async () => {
    const sseBody = sseEvent({
      type: "response.failed",
      response: {
        id: "resp_3",
        object: "response",
        status: "failed",
        error: { code: "rate_limit", message: "Rate limited" },
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
    });

    const events = (await collectEvents(streamFn(testModel(), testContext(), {}))) as Array<{
      type: string;
    }>;

    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("sends Authorization header and correct URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseEvent({
          type: "response.completed",
          response: {
            id: "resp_4",
            object: "response",
            status: "completed",
            model: "test-model",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "sk-test-123",
      baseUrl: "https://custom.api.com",
    });

    await collectEvents(streamFn(testModel(), testContext(), {}));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://custom.api.com/v1/responses");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sk-test-123",
    );
  });

  it("handles baseUrl that already ends with /v1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseEvent({
          type: "response.completed",
          response: {
            id: "resp_5",
            object: "response",
            status: "completed",
            model: "test-model",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "test",
      baseUrl: "https://custom.api.com/v1",
    });

    await collectEvents(streamFn(testModel(), testContext(), {}));

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://custom.api.com/v1/responses");
  });

  it("includes stream: true in the request body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        sseEvent({
          type: "response.completed",
          response: {
            id: "resp_6",
            object: "response",
            status: "completed",
            model: "test-model",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const streamFn = createOpenAIResponsesHttpStreamFn({
      apiKey: "test",
      baseUrl: "https://api.example.com/v1",
    });

    await collectEvents(streamFn(testModel(), testContext(), {}));

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("test-model");
    expect(body.instructions).toBe("You are helpful.");
  });
});
