import {
  parseStreamingJson,
  type AssistantMessageEvent,
  type Model,
  type Usage,
} from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRadiusStreamFn } from "./stream.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn<typeof fetch>() }));
vi.mock("openclaw/plugin-sdk/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/llm")>();
  return { ...actual, parseStreamingJson: vi.fn(actual.parseStreamingJson) };
});
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: () => fetchMock,
}));

const model: Model = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "radius",
  api: "pi-messages",
  baseUrl: "https://radius.pi.dev/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const usage: Usage = {
  input: 50,
  output: 12,
  cacheRead: 10,
  cacheWrite: 4,
  totalTokens: 76,
  cost: {
    input: 0.00015,
    output: 0.00018,
    cacheRead: 0.000003,
    cacheWrite: 0.000015,
    total: 0.000348,
  },
};
const context = {
  systemPrompt: "Be helpful.",
  messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }],
};
const options = { apiKey: "synthetic-radius-token" };

function response(events: unknown[], trailing = "") {
  const wire =
    ": keepalive\r\n\r\n" +
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") +
    trailing;
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split CRLF delimiters, UTF-8 code points, and JSON across transport chunks.
        for (let i = 0; i < bytes.length; i += 7) {
          controller.enqueue(bytes.slice(i, i + 7));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-request" } },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(parseStreamingJson).mockClear();
});

describe("Radius native message transport", () => {
  it("omits disabled reasoning from Pi requests without changing the output cap", async () => {
    fetchMock.mockResolvedValue(response([{ type: "done", reason: "stop", usage }]));
    await createRadiusStreamFn()(model, context, {
      ...options,
      reasoning: "off",
      maxTokens: 1024,
    }).result();
    expect(await new Response(fetchMock.mock.calls[0]![1]?.body).json()).toEqual({
      model: model.id,
      context,
      options: { maxTokens: 1024 },
    });
  });

  it("bounds large-tool preview work while emitting every delta and the final arguments", async () => {
    const toolArguments = { content: "a".repeat(100_000) };
    const json = JSON.stringify(toolArguments);
    const deltas = Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) =>
      json.slice(index * 1000, (index + 1) * 1000),
    );
    fetchMock.mockResolvedValue(
      response([
        { type: "start" },
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
        ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { type: "toolCall", id: "call-1", name: "write", arguments: toolArguments },
        },
        { type: "done", reason: "toolUse", usage },
      ]),
    );
    const stream = createRadiusStreamFn()(model, context, options);
    const observed: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_delta") {
        observed.push(event.delta);
      }
    }
    expect(observed).toEqual(deltas);
    expect(parseStreamingJson).toHaveBeenCalled();
    expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(deltas.length / 4);
    expect(await stream.result()).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", arguments: toolArguments }],
    });
  });

  it.each(["\n\n", ""])(
    "rejects an oversized complete frame with delimiter %j",
    async (delimiter) => {
      const oversized = JSON.stringify({ type: "start", padding: "a".repeat(16 * 1024 * 1024) });
      fetchMock.mockResolvedValue(new Response(`data: ${oversized}${delimiter}`));
      const result = await createRadiusStreamFn()(model, context, options).result();
      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: "Radius SSE event exceeds 16 MiB",
      });
    },
  );

  it("preserves signed content, authoritative tool calls and usage across fragmented SSE", async () => {
    fetchMock.mockResolvedValue(
      response([
        { type: "start" },
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "Consider" },
        {
          type: "thinking_end",
          contentIndex: 0,
          content: "Consider the result",
          contentSignature: "thinking-signature",
          redacted: true,
        },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "Héllo" },
        {
          type: "text_end",
          contentIndex: 1,
          content: "Héllo!",
          contentSignature: "text-signature",
        },
        { type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "lookup" },
        { type: "toolcall_delta", contentIndex: 2, delta: '{"city":"Vie' },
        {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: {
            type: "toolCall",
            id: "call-1",
            name: "lookup",
            arguments: { city: "Vienna" },
            thoughtSignature: "tool-signature",
          },
        },
        { type: "done", reason: "toolUse", usage, responseId: "response-1" },
      ]),
    );
    const stream = createRadiusStreamFn()(model, context, {
      ...options,
      reasoning: "high",
      maxTokens: 512,
      temperature: 0.2,
      sessionId: "session-1",
      cacheRetention: "long",
      toolChoice: "required",
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(await stream.result()).toMatchObject({
      stopReason: "toolUse",
      responseId: "response-1",
      usage,
      content: [
        {
          type: "thinking",
          thinking: "Consider the result",
          thinkingSignature: "thinking-signature",
          redacted: true,
        },
        { type: "text", text: "Héllo!", textSignature: "text-signature" },
        {
          type: "toolCall",
          id: "call-1",
          name: "lookup",
          arguments: { city: "Vienna" },
          thoughtSignature: "tool-signature",
        },
      ],
    });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://radius.pi.dev/v1/messages");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer synthetic-radius-token",
    );
    expect(await new Response(request?.body).json()).toEqual({
      model: model.id,
      context,
      options: {
        reasoning: "high",
        maxTokens: 512,
        temperature: 0.2,
        sessionId: "session-1",
        cacheRetention: "long",
        toolChoice: "required",
      },
    });
  });

  it("applies payload replacements and observes response metadata before body events", async () => {
    fetchMock.mockResolvedValue(response([{ type: "done", reason: "stop", usage }]));
    const onResponse = vi.fn();
    const stream = createRadiusStreamFn()(model, context, {
      ...options,
      onPayload: () => ({ model: "claude-sonnet-4", context: { messages: [] }, options: {} }),
      onResponse,
    });
    for await (const event of stream) {
      expect(onResponse).toHaveBeenCalledOnce();
      expect(event.type).toBe("done");
    }
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-request" },
      },
      model,
    );
    expect(await new Response(fetchMock.mock.calls[0]![1]?.body).json()).toEqual({
      model: "claude-sonnet-4",
      context: { messages: [] },
      options: {},
    });
  });

  it.each(["error", "aborted"])(
    "preserves server %s terminal state and accounting",
    async (reason) => {
      fetchMock.mockResolvedValue(
        response([
          {
            type: "error",
            reason,
            errorMessage: "Radius stopped generation",
            usage,
            responseId: "error-response",
          },
        ]),
      );
      const result = await createRadiusStreamFn()(model, context, options).result();
      expect(result).toMatchObject({
        stopReason: reason,
        errorMessage: "Radius stopped generation",
        responseId: "error-response",
        usage,
      });
    },
  );

  it.each([
    {
      name: "missing terminal",
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "partial" },
      ],
      error: "without a terminal event",
    },
    {
      name: "unfinished tool",
      events: [
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "lookup" },
        { type: "done", reason: "toolUse", usage },
      ],
      error: "unfinished tool call",
    },
    {
      name: "invalid event",
      events: [{ type: "text_delta", contentIndex: 0, delta: "orphan" }],
      error: "content block sequence",
    },
    {
      name: "non-object tool arguments",
      events: [
        { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "lookup" },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { type: "toolCall", id: "call-1", name: "lookup", arguments: [] },
        },
      ],
      error: "tool",
    },
  ])("fails $name instead of silently completing", async ({ events, error }) => {
    fetchMock.mockResolvedValue(response(events));
    const stream = createRadiusStreamFn()(model, context, options);
    const terminal: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      if (event.type === "error" || event.type === "done") {
        terminal.push(event);
      }
    }
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.type).toBe("error");
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining(error),
    });
  });

  it("cancels an open response promptly when the caller aborts", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\n'));
          },
          cancel: cancelled,
        }),
      ),
    );
    const stream = createRadiusStreamFn()(model, context, {
      ...options,
      signal: controller.signal,
    });
    for await (const event of stream) {
      if (event.type === "start") {
        controller.abort();
      }
    }
    expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("releases an open response after terminal completion", async () => {
    const cancelled = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`,
              ),
            );
          },
          cancel: cancelled,
        }),
      ),
    );
    expect(await createRadiusStreamFn()(model, context, options).result()).toMatchObject({
      stopReason: "stop",
    });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("surfaces HTTP failures with status and response-hook metadata", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }),
    );
    const onResponse = vi.fn();
    const result = await createRadiusStreamFn()(model, context, {
      ...options,
      onResponse,
    }).result();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("429"),
    });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }), model);
  });

  it("does not dispatch after cancellation during payload preparation", async () => {
    const controller = new AbortController();
    const result = await createRadiusStreamFn()(model, context, {
      ...options,
      signal: controller.signal,
      onPayload: async () => {
        controller.abort();
      },
    }).result();
    expect(result.stopReason).toBe("aborted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
