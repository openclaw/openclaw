import {
  parseStreamingJson,
  type AssistantMessageEvent,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { beforeEach, expect, it, vi } from "vitest";
import { createRadiusStreamFn } from "./stream.js";
import { baseUrl, catalogModel, sse, usage } from "./test-support.js";

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
  ...catalogModel("claude-sonnet-4", "Claude Sonnet 4", 200_000),
  provider: "radius",
  api: "pi-messages",
  baseUrl,
};
const context = {
  systemPrompt: "Be helpful.",
  messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }],
};
const options = { apiKey: "synthetic-radius-token" };

function response(events: readonly unknown[], open = false) {
  const { promise: cancelled, resolve } = Promise.withResolvers<void>();
  const cancel = vi.fn(resolve);
  const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" + sse(events));
  return {
    cancel,
    cancelled,
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Split CRLF delimiters, UTF-8 code points, and JSON across transport chunks.
          for (let i = 0; i < bytes.length; i += 7) {
            controller.enqueue(bytes.slice(i, i + 7));
          }
          if (!open) {
            controller.close();
          }
        },
        cancel,
      }),
      { headers: { "content-type": "text/event-stream", "x-request-id": "synthetic-request" } },
    ),
  };
}

const toolStart = (contentIndex = 0, toolName = "lookup") => ({
  type: "toolcall_start",
  contentIndex,
  id: "call-1",
  toolName,
});
const toolCall = (arguments_: unknown, name = "lookup") => ({
  type: "toolCall",
  id: "call-1",
  name,
  arguments: arguments_,
});
const toolEnd = (call: ReturnType<typeof toolCall>, contentIndex = 0) => ({
  type: "toolcall_end",
  contentIndex,
  toolCall: call,
});
const done = (reason = "stop") => ({ type: "done", reason, usage });
const run = (extra: Parameters<ReturnType<typeof createRadiusStreamFn>>[2] = {}) =>
  createRadiusStreamFn()(model, context, { ...options, ...extra });
const requestBody = () => new Response(fetchMock.mock.calls[0]![1]?.body).json();
const mockEvents = (events: readonly unknown[]) =>
  fetchMock.mockResolvedValue(response(events).response);

async function collect(stream: ReturnType<typeof run>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(parseStreamingJson).mockClear();
});

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
    toolEnd(toolCall(toolArguments, "write")),
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

it.each(["\n\n", ""])("rejects oversized frame delimiter %j", async (delimiter) => {
  const oversized = JSON.stringify({ type: "start", padding: "a".repeat(16 * 1024 * 1024) });
  fetchMock.mockResolvedValue(new Response(`data: ${oversized}${delimiter}`));
  expect(await run().result()).toMatchObject({
    stopReason: "error",
    errorMessage: "Radius SSE event exceeds 16 MiB",
  });
});

it("preserves signed content, authoritative tool calls and usage across fragmented SSE", async () => {
  const signedTool = { ...toolCall({ city: "Vienna" }), thoughtSignature: "tool-signature" };
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
    toolEnd(signedTool, 2),
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
  const events = await collect(stream);
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
      signedTool,
    ],
  });
  const [url, request] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://radius.pi.dev/v1/messages");
  expect(new Headers(request?.headers).get("authorization")).toBe("Bearer synthetic-radius-token");
  expect(await requestBody()).toEqual({
    model: model.id,
    context,
    options: requestOptions,
  });
});

it.each([200, 429])(
  "reports HTTP %s metadata before events and applies payload replacements",
  async (status) => {
    const headers = { "content-type": "text/event-stream", "x-request-id": "synthetic-request" };
    fetchMock.mockResolvedValue(
      new Response(
        status === 200 ? sse([done()]) : JSON.stringify({ error: { message: "Quota exceeded" } }),
        { status, headers },
      ),
    );
    const onResponse = vi.fn();
    const replacement = { model: "claude-sonnet-4", context: { messages: [] }, options: {} };
    const stream = run({
      onPayload: () => replacement,
      onResponse,
    });
    for await (const event of stream) {
      expect(onResponse).toHaveBeenCalledOnce();
      expect(event.type).toBe(status === 200 ? "done" : "error");
    }
    expect(onResponse).toHaveBeenCalledWith({ status, headers }, model);
    expect(await requestBody()).toEqual(replacement);
    expect(await stream.result()).toMatchObject(
      status === 200
        ? { stopReason: "stop" }
        : { stopReason: "error", errorMessage: expect.stringContaining("429") },
    );
  },
);

it.each(["error", "aborted"])("preserves %s terminal accounting", async (reason) => {
  mockEvents([
    {
      type: "error",
      reason,
      errorMessage: "Radius stopped generation",
      usage,
      responseId: "error-response",
    },
  ]);
  expect(await run().result()).toMatchObject({
    stopReason: reason,
    errorMessage: "Radius stopped generation",
    responseId: "error-response",
    usage,
  });
});

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
  ["non-object tool arguments", [toolStart(), toolEnd(toolCall([]))], "tool"],
] as const)("fails %s instead of silently completing", async (_name, events, error) => {
  mockEvents(events);
  const stream = run();
  const terminal = (await collect(stream)).filter(
    ({ type }) => type === "error" || type === "done",
  );
  expect(terminal.map(({ type }) => type)).toEqual(["error"]);
  expect(await stream.result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining(error),
  });
  for (const block of (await stream.result()).content) {
    expect(block).not.toHaveProperty("partialJson");
  }
});

it.each([true, false])("releases an open response after caller abort=%s", async (abort) => {
  const controller = new AbortController();
  const open = response([abort ? { type: "start" } : done()], true);
  fetchMock.mockResolvedValue(open.response);
  const stream = run({ signal: controller.signal });
  for await (const event of stream) {
    if (abort && event.type === "start") {
      controller.abort();
    }
  }
  expect(await stream.result()).toMatchObject({ stopReason: abort ? "aborted" : "stop" });
  await open.cancelled;
  expect(open.cancel).toHaveBeenCalledOnce();
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
