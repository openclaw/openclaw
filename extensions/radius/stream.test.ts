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

function response(events: readonly unknown[]) {
  const wire =
    ": keepalive\r\n\r\n" +
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
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

function openResponse(event: unknown) {
  const { promise: cancelled, resolve } = Promise.withResolvers<void>();
  const cancel = vi.fn(resolve);
  return {
    response: new Response(
      new ReadableStream({
        start(body) {
          body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        },
        cancel,
      }),
    ),
    cancel,
    cancelled,
  };
}

const toolStart = (contentIndex = 0, toolName = "lookup") => ({
  type: "toolcall_start",
  contentIndex,
  id: "call-1",
  toolName,
});
const toolEnd = (
  arguments_: unknown,
  contentIndex = 0,
  name = "lookup",
  thoughtSignature?: string,
) => ({
  type: "toolcall_end",
  contentIndex,
  toolCall: {
    type: "toolCall",
    id: "call-1",
    name,
    arguments: arguments_,
    ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
  },
});
const done = (reason = "stop") => ({ type: "done", reason, usage });
const run = (extra: Parameters<ReturnType<typeof createRadiusStreamFn>>[2] = {}) =>
  createRadiusStreamFn()(model, context, { ...options, ...extra });
const requestBody = () => new Response(fetchMock.mock.calls[0]![1]?.body).json();
const mockEvents = (events: readonly unknown[]) => fetchMock.mockResolvedValue(response(events));

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(parseStreamingJson).mockClear();
});

describe("Radius native message transport", () => {
  it("omits disabled reasoning from Pi requests without changing the output cap", async () => {
    mockEvents([done()]);
    await run({ reasoning: "off", maxTokens: 1024 }).result();
    expect(await requestBody()).toEqual({
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
    mockEvents([
      { type: "start" },
      toolStart(0, "write"),
      ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
      toolEnd(toolArguments, 0, "write"),
      done("toolUse"),
    ]);
    const stream = run();
    const observed: string[] = [];
    for await (const event of stream) {
      if (event.type === "toolcall_delta") {
        observed.push(event.delta);
        expect(event.partial.content[event.contentIndex]).toMatchObject({
          partialJson: observed.join(""),
        });
      }
    }
    expect(observed).toEqual(deltas);
    expect(parseStreamingJson).toHaveBeenCalled();
    expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(deltas.length / 4);
    expect(await stream.result()).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", arguments: toolArguments }],
    });
    expect((await stream.result()).content[0]).not.toHaveProperty("partialJson");
  });

  it.each(["\n\n", ""])(
    "rejects an oversized complete frame with delimiter %j",
    async (delimiter) => {
      const oversized = JSON.stringify({ type: "start", padding: "a".repeat(16 * 1024 * 1024) });
      fetchMock.mockResolvedValue(new Response(`data: ${oversized}${delimiter}`));
      const result = await run().result();
      expect(result).toMatchObject({
        stopReason: "error",
        errorMessage: "Radius SSE event exceeds 16 MiB",
      });
    },
  );

  it("preserves signed content, authoritative tool calls and usage across fragmented SSE", async () => {
    mockEvents([
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
      toolStart(2),
      { type: "toolcall_delta", contentIndex: 2, delta: '{"city":"Vie' },
      toolEnd({ city: "Vienna" }, 2, "lookup", "tool-signature"),
      { ...done("toolUse"), responseId: "response-1" },
    ]);
    const requestOptions = {
      reasoning: "high",
      maxTokens: 512,
      temperature: 0.2,
      sessionId: "session-1",
      cacheRetention: "long",
      toolChoice: "required",
    } as const;
    const stream = run(requestOptions);
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(
      "start thinking_start thinking_delta thinking_end text_start text_delta text_end toolcall_start toolcall_delta toolcall_end done".split(
        " ",
      ),
    );
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
    expect(await requestBody()).toEqual({
      model: model.id,
      context,
      options: requestOptions,
    });
  });

  it("applies payload replacements and observes response metadata before body events", async () => {
    mockEvents([done()]);
    const onResponse = vi.fn();
    const replacement = { model: "claude-sonnet-4", context: { messages: [] }, options: {} };
    const stream = run({
      onPayload: () => replacement,
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
    expect(await requestBody()).toEqual(replacement);
  });

  it.each(["error", "aborted"])(
    "preserves server %s terminal state and accounting",
    async (reason) => {
      mockEvents([
        {
          type: "error",
          reason,
          errorMessage: "Radius stopped generation",
          usage,
          responseId: "error-response",
        },
      ]);
      const result = await run().result();
      expect(result).toMatchObject({
        stopReason: reason,
        errorMessage: "Radius stopped generation",
        responseId: "error-response",
        usage,
      });
    },
  );

  it.each([
    [
      "missing terminal",
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "partial" },
      ],
      "without a terminal event",
    ],
    ["unfinished tool", [toolStart(), done("toolUse")], "unfinished tool call"],
    [
      "invalid event",
      [{ type: "text_delta", contentIndex: 0, delta: "orphan" }],
      "content block sequence",
    ],
    ["non-object tool arguments", [toolStart(), toolEnd([])], "tool"],
  ] as const)("fails %s instead of silently completing", async (_name, events, error) => {
    mockEvents(events);
    const stream = run();
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
    for (const block of (await stream.result()).content) {
      expect(block).not.toHaveProperty("partialJson");
    }
  });

  it("cancels an open response promptly when the caller aborts", async () => {
    const controller = new AbortController();
    const open = openResponse({ type: "start" });
    fetchMock.mockResolvedValue(open.response);
    const stream = run({ signal: controller.signal });
    for await (const event of stream) {
      if (event.type === "start") {
        controller.abort();
      }
    }
    expect(await stream.result()).toMatchObject({ stopReason: "aborted" });
    expect(open.cancel).toHaveBeenCalledOnce();
  });

  it("releases an open response after terminal completion", async () => {
    const open = openResponse(done());
    fetchMock.mockResolvedValue(open.response);
    expect(await run().result()).toMatchObject({
      stopReason: "stop",
    });
    await open.cancelled;
    expect(open.cancel).toHaveBeenCalledOnce();
  });

  it("surfaces HTTP failures with status and response-hook metadata", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }),
    );
    const onResponse = vi.fn();
    const result = await run({ onResponse }).result();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("429"),
    });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }), model);
  });

  it("does not dispatch after cancellation during payload preparation", async () => {
    const controller = new AbortController();
    const result = await run({
      signal: controller.signal,
      onPayload: async () => {
        controller.abort();
      },
    }).result();
    expect(result.stopReason).toBe("aborted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
