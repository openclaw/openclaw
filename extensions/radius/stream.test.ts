import { parseStreamingJson, type Model } from "openclaw/plugin-sdk/llm";
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
const headers = { "content-type": "text/event-stream", "x-request-id": "synthetic-request" };

function response(events: readonly unknown[], open = false) {
  const { promise: cancelled, resolve } = Promise.withResolvers<void>();
  const cancel = vi.fn(resolve);
  const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" + sse(events));
  const body = new ReadableStream<Uint8Array>({
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
  });
  return { cancel, cancelled, response: new Response(body, { headers }) };
}

const frame = (type: string, i: number, fields = {}) => ({ type, contentIndex: i, ...fields });
const toolStart = (index = 0) => frame("toolcall_start", index, { id: "c", toolName: "f" });
const toolCall = (args: unknown) => ({ type: "toolCall", id: "c", name: "f", arguments: args });
const toolEnd = (call: ReturnType<typeof toolCall>, index = 0) =>
  frame("toolcall_end", index, { toolCall: call });
const done = (reason = "stop") => ({ type: "done", reason, usage });
const run = (extra: Parameters<ReturnType<typeof createRadiusStreamFn>>[2] = {}) =>
  createRadiusStreamFn()(model, context, { ...options, ...extra });
const requestBody = () => new Response(fetchMock.mock.calls[0]![1]?.body).json();
const mockEvents = (events: readonly unknown[]) =>
  fetchMock.mockResolvedValue(response(events).response);

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(parseStreamingJson).mockClear();
});

it.each(["\n\n", ""])("rejects oversized frame delimiter %j", async (delimiter) => {
  const oversized = JSON.stringify({ type: "start", padding: "a".repeat(16 * 1024 * 1024) });
  fetchMock.mockResolvedValue(new Response(`data: ${oversized}${delimiter}`));
  const { stopReason, errorMessage } = await run().result();
  expect([stopReason, errorMessage]).toEqual(["error", "Radius SSE event exceeds 16 MiB"]);
});

it("preserves signed content, bounded tool previews and accounting across fragmented SSE", async () => {
  const previewArguments = { content: "a".repeat(100_000) };
  const toolArguments = { ...previewArguments, complete: true };
  const json = JSON.stringify(previewArguments);
  const deltas = json.match(/.{1,1000}/gu) ?? [];
  const signedTool = { ...toolCall(toolArguments), thoughtSignature: "s" };
  const input = [
    { type: "start" },
    frame("thinking_start", 0),
    frame("thinking_delta", 0, { delta: "th" }),
    frame("thinking_end", 0, { content: "thought", contentSignature: "s", redacted: true }),
    frame("text_start", 1),
    frame("text_delta", 1, { delta: "é" }),
    frame("text_end", 1, { content: "é!", contentSignature: "s" }),
    toolStart(2),
    ...deltas.map((delta) => frame("toolcall_delta", 2, { delta })),
    toolEnd(signedTool, 2),
    { ...done("toolUse"), responseId: "r" },
  ];
  mockEvents(input);
  const requestOptions = {
    reasoning: "high",
    maxTokens: 512,
    temperature: 0.2,
    sessionId: "session-1",
    cacheRetention: "long",
    toolChoice: "required",
  } as const;
  const onResponse = vi.fn();
  const stream = run({ ...requestOptions, onResponse });
  const observed: string[] = [];
  const types: string[] = [];
  for await (const event of stream) {
    expect(onResponse).toHaveBeenCalledOnce();
    types.push(event.type);
    if (event.type === "toolcall_delta") {
      observed.push(event.delta);
      expect(event.partial.content[event.contentIndex]).toMatchObject({
        partialJson: observed.join(""),
      });
    }
  }
  expect(types).toEqual(input.map(({ type }) => type));
  expect(onResponse).toHaveBeenCalledWith({ status: 200, headers }, model);
  expect(observed).toEqual(deltas);
  expect(parseStreamingJson).toHaveBeenCalled();
  expect(vi.mocked(parseStreamingJson).mock.calls.length).toBeLessThan(deltas.length / 4);
  expect((await stream.result()).content[2]).not.toHaveProperty("partialJson");
  expect(await stream.result()).toMatchObject({
    stopReason: "toolUse",
    responseId: "r",
    usage,
    content: [
      { type: "thinking", thinking: "thought", thinkingSignature: "s", redacted: true },
      { type: "text", text: "é!", textSignature: "s" },
      signedTool,
    ],
  });
  const [url, request] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://radius.pi.dev/v1/messages");
  expect(new Headers(request?.headers).get("authorization")).toBe("Bearer synthetic-radius-token");
  expect(await requestBody()).toEqual({ model: model.id, context, options: requestOptions });
});

it("reports HTTP errors after payload preparation and response notification", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { message: "Quota exceeded" } }, { status: 429, headers }),
  );
  const onResponse = vi.fn();
  const replacement = { model: "claude-sonnet-4", context: { messages: [] }, options: {} };
  const stream = run({
    reasoning: "off",
    maxTokens: 1024,
    onPayload: (payload) => {
      expect(payload).toEqual({ model: model.id, context, options: { maxTokens: 1024 } });
      return replacement;
    },
    onResponse,
  });
  await Array.fromAsync(stream, () => expect(onResponse).toHaveBeenCalledOnce());
  expect(onResponse).toHaveBeenCalledWith({ status: 429, headers }, model);
  expect(await requestBody()).toEqual(replacement);
  expect(await stream.result()).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("429"),
  });
});

it.each(["error", "aborted"])("preserves %s terminal accounting", async (reason) => {
  const accounting = { errorMessage: "stopped", usage, responseId: "r" };
  mockEvents([{ type: "error", reason, ...accounting }]);
  expect(await run().result()).toMatchObject({ stopReason: reason, ...accounting });
});

it.each([
  [
    "missing terminal",
    [frame("text_start", 0), frame("text_delta", 0, { delta: "partial" })],
    "without a terminal event",
  ],
  ["unfinished tool", [toolStart(), done("toolUse")], "unfinished tool call"],
  ["invalid event", [frame("text_delta", 0, { delta: "orphan" })], "content block sequence"],
  ["non-object tool arguments", [toolStart(), toolEnd(toolCall([]))], "tool"],
] as const)("fails %s instead of silently completing", async (_name, events, error) => {
  mockEvents(events);
  const stream = run();
  const types = await Array.fromAsync(stream, (event) => event.type);
  expect(types.filter((type) => type === "error" || type === "done")).toEqual(["error"]);
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
    onPayload: async () => controller.abort(),
  }).result();
  expect(result.stopReason).toBe("aborted");
  expect(fetchMock).not.toHaveBeenCalled();
});
