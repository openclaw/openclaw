/// <reference lib="esnext.array" />
import { expectDefined } from "@openclaw/normalization-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { AssistantMessage, AssistantMessageEvent, Model } from "openclaw/plugin-sdk/llm";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createRequireRecord, makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";

const { guardedFetch } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
}));

// mock-isolation: Keep HTTP and DNS access inside the synthetic stream transport.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: guardedFetch,
}));

import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { OLLAMA_INCOMPLETE_STREAM_ERROR } from "./stream-contract.js";
import { convertToOllamaMessages } from "./stream-messages.js";
import { parseNdjsonStream } from "./stream-ndjson.js";
import {
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  buildAssistantMessage,
} from "./stream.runtime.js";

type GuardedFetchCall = Parameters<typeof fetchWithSsrFGuard>[0];

const requireRecord = createRequireRecord("object", "expected-label");

function convertAssistantContent(
  content: AssistantMessage["content"],
  options?: Parameters<typeof convertToOllamaMessages>[2],
) {
  return convertToOllamaMessages([makeAgentAssistantMessage({ content })], undefined, options);
}

type AssistantResponse = Parameters<typeof buildAssistantMessage>[0];
type AssistantResponseMessage = AssistantResponse["message"];

function createAssistantResponse(
  message: Omit<AssistantResponseMessage, "role">,
  overrides: Partial<Omit<AssistantResponse, "message">> = {},
): AssistantResponse {
  return {
    model: "qwen3:32b",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant", ...message },
    done: true,
    ...overrides,
  };
}

function ndjson(
  message: Partial<AssistantResponseMessage> = {},
  response: Partial<Omit<AssistantResponse, "message">> = {},
): string {
  return JSON.stringify(
    createAssistantResponse({ content: "", ...message }, { done: false, ...response }),
  );
}

const hiddenReasoning =
  "I should think privately and not leak this planning text in the answer. I need to keep deciding what to say next.";
const textEvents = "start text_start text_delta text_end done";
const bashCall = { function: { name: "bash", arguments: { command: "ls" } } };
const replySchema = { type: "object", properties: { reply: { type: "string" } } };
const modelInfo = { api: "ollama", provider: "ollama", id: "qwen3:32b" };

afterEach(() => {
  guardedFetch.mockReset();
  vi.useRealTimers();
});

describe("createConfiguredOllamaCompatStreamWrapper", () => {
  it("defaults a bare request to streaming and removes the Ollama prefix", () => {
    expect(buildOllamaChatRequest({ modelId: "ollama/qwen3", messages: [] })).toEqual({
      model: "qwen3",
      messages: [],
      stream: true,
    });
  });
  it("preserves compat Kimi thinking and configured context", async () => {
    const id = "kimi-k2.5:cloud";
    const model: Model = {
      ...createModel(id, id, { reasoning: true, contextWindow: 262144 }),
      api: "openai-completions",
      provider: "ollama",
      baseUrl: "http://ollama-host:11434",
      params: { num_ctx: 65536 },
    };
    let patched: unknown;
    const wrapped = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: model.provider,
        modelId: id,
        model,
        thinkingLevel: "high",
        streamFn: (_model, _context, options) => {
          options?.onPayload?.({ tool_choice: "auto" }, model);
          return createAssistantMessageEventStream();
        },
      }),
      "compat wrapper",
    );
    await wrapped(
      model,
      { messages: [] },
      {
        onPayload: (value) => {
          patched = value;
        },
      },
    );
    const { thinking, options } = requireRecord(patched, "patched payload");
    expect({ thinking, options }).toEqual({
      thinking: { type: "enabled" },
      options: { num_ctx: 65536 },
    });
  });

  it.each(["ollama", "ollama-spark"])(
    "strips the %s prefix on native streaming requests",
    async (provider) => {
      const { body } = await successfulOllamaRequest({
        model: { provider, id: provider + "/qwen3:32b" },
      });
      expect(body).toMatchObject({
        model: "qwen3:32b",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(body.options).not.toHaveProperty("num_ctx");
    },
  );
});

describe("convertToOllamaMessages", () => {
  it("normalizes allowlisted replay prefixes without changing real tool names", () => {
    expect(
      convertAssistantContent(
        [
          { type: "toolCall", id: "call_1", name: "tools_exec", arguments: { command: "pwd" } },
          { type: "toolCall", id: "call_2", name: "function-read", arguments: { path: "." } },
          { type: "toolCall", id: "call_3", name: "tool_missing", arguments: {} },
          { type: "toolCall", id: "call_4", name: "tool_a", arguments: {} },
        ],
        { availableToolNames: new Set(["exec", "read", "tool_a"]) },
      )[0],
    ).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", function: { name: "exec", arguments: { command: "pwd" } } },
        { id: "call_2", function: { name: "read", arguments: { path: "." } } },
        { id: "call_3", function: { name: "tool_missing", arguments: {} } },
        { id: "call_4", function: { name: "tool_a", arguments: {} } },
      ],
    });
  });

  it("replays thinking alongside text without redacted blocks", () => {
    expect(
      convertAssistantContent([
        { type: "thinking", thinking: "Check the directory.\n" },
        { type: "thinking", thinking: "Then report its contents." },
        { type: "thinking", thinking: "redacted reasoning", redacted: true },
        { type: "text", text: "Let me check." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ])[0],
    ).toEqual({
      role: "assistant",
      content: "Let me check.",
      thinking: "Check the directory.\nThen report its contents.",
      tool_calls: [{ id: "call_1", ...bashCall }],
    });
  });
});

describe("buildAssistantMessage", () => {
  const emojiAnswer =
    "This is a normal Kimi cloud answer with enough length to cross the prefix threshold and no hidden reasoning leak. ☀️sunshine should remain visible to the user.";
  it("preserves visible content for Kimi emoji variation selectors", () => {
    const result = buildAssistantMessage(createAssistantResponse({ content: emojiAnswer }), {
      ...modelInfo,
      id: "kimi-k2.6:cloud",
    });
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: emojiAnswer }]);
  });
});

function createPendingCancelNdjsonStream(lines: string[]) {
  const encoder = new TextEncoder();
  const { promise: cancelStarted, resolve: markCancelStarted } = Promise.withResolvers<void>();
  const { promise: cancelPending, resolve: settleCancel } = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
    },
    cancel() {
      markCancelStarted();
      return cancelPending;
    },
  });
  return {
    cancelPending,
    cancelStarted,
    reader: stream.getReader(),
    settleCancel,
    stream,
  };
}

describe("parseNdjsonStream", () => {
  it("unlocks a real stream before pending cancellation settles on early break", async () => {
    const source = createPendingCancelNdjsonStream([
      ndjson({ content: "one" }),
      ndjson({ content: "two" }, { done: true }),
    ]);
    const iteration = (async () => {
      for await (const chunk of parseNdjsonStream(source.reader)) {
        expect(chunk.message.content).toBe("one");
        break;
      }
    })();

    await source.cancelStarted;
    await iteration;
    expect(source.stream.locked).toBe(false);

    source.settleCancel();
    await source.cancelPending;
  });
});

const ndjsonHeaders = { "Content-Type": "application/x-ndjson" };
const successCounts = { done: true, prompt_eval_count: 1, eval_count: 1 };
const successBody = [ndjson({ content: "ok" }), ndjson({}, successCounts)].join("\n") + "\n";

function mockResponse(body: BodyInit | null, init?: ResponseInit, refreshTimeout?: () => void) {
  const release = vi.fn(async () => undefined);
  guardedFetch.mockResolvedValue({ response: new Response(body, init), release, refreshTimeout });
  return release;
}

const mockSuccess = () => mockResponse(successBody, { headers: ndjsonHeaders });

function createControlledNdjsonFetch() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const refreshTimeout = vi.fn();
  const release = mockResponse(body, { headers: ndjsonHeaders }, refreshTimeout);
  return {
    release,
    refreshTimeout,
    pushLine: (line: string) =>
      expectDefined(controller, "NDJSON controller").enqueue(encoder.encode(`${line}\n`)),
    close: () => expectDefined(controller, "NDJSON controller").close(),
  };
}

function requestCall(): GuardedFetchCall {
  return (guardedFetch.mock.calls.at(0)?.[0] as GuardedFetchCall | undefined) ?? { url: "" };
}

function requestBody(): Record<string, unknown> {
  const body = requestCall().init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected string request body");
  }
  return requireRecord(JSON.parse(body), "Ollama request body");
}

async function openStream(
  params: {
    baseUrl?: string;
    configured?: Parameters<typeof createConfiguredOllamaStreamFn>[0];
    defaultHeaders?: Record<string, string>;
    model?: Record<string, unknown>;
    context?: Record<string, unknown>;
    options?: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] &
      Partial<
        Record<"timeoutMs" | "topP" | "seed" | "frequencyPenalty" | "presencePenalty", number>
      >;
  } = {},
) {
  const streamFn = params.configured
    ? createConfiguredOllamaStreamFn(params.configured)
    : createOllamaStreamFn(params.baseUrl ?? "http://ollama-host:11434", params.defaultHeaders);
  return streamFn(
    {
      id: "qwen3:32b",
      api: "ollama",
      provider: "custom-ollama",
      input: ["text"],
      contextWindow: 131072,
      ...params.model,
    } as unknown as Parameters<typeof streamFn>[0],
    (params.context ?? {
      messages: [{ role: "user", content: "hello" }],
    }) as unknown as Parameters<typeof streamFn>[1],
    (params.options ?? {}) as unknown as Parameters<typeof streamFn>[2],
  );
}

type OllamaLocalService = NonNullable<
  Parameters<typeof createConfiguredOllamaStreamFn>[0]["localService"]
>;

async function openManaged(params: {
  baseUrl?: string;
  providerId?: string;
  defaultHeaders?: Record<string, string>;
  model?: Record<string, unknown>;
  context?: Record<string, unknown>;
  options?: Parameters<ReturnType<typeof createConfiguredOllamaStreamFn>>[2];
  acquire: OllamaLocalService["acquire"];
}) {
  const baseUrl = params.baseUrl ?? "http://provider-host:11434";
  const providerId = params.providerId ?? "custom-ollama";
  return openStream({
    ...params,
    baseUrl,
    model: { provider: providerId, ...params.model },
    configured: {
      model: { baseUrl, headers: params.defaultHeaders },
      providerBaseUrl: baseUrl,
      localService: { providerId, acquire: params.acquire },
    },
  });
}

async function expectNext(
  iterator: AsyncIterator<OllamaStreamEvent>,
  value: Record<string, unknown>,
) {
  await expect(iterator.next()).resolves.toMatchObject({ done: false, value });
}

const collectEvents = async (params: Parameters<typeof openStream>[0] = {}) =>
  Array.fromAsync(await openStream(params));
const collectManaged = async (params: Parameters<typeof openManaged>[0]) =>
  Array.fromAsync(await openManaged(params));

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

type OllamaStreamEvent = AssistantMessageEvent;

function expectEventTypes(events: OllamaStreamEvent[], types: string) {
  expect(events.map((event) => event.type)).toEqual(types.split(" "));
}

function expectTextAppends(events: OllamaStreamEvent[], text: string) {
  const deltas = events.filter((event) => event.type === "text_delta");
  expect(deltas.map((event) => event.delta).join("")).toBe(text);
  for (const delta of deltas) {
    expect(delta.contentIndex).toBe(0);
    expect(delta).not.toHaveProperty("partial");
  }
}

async function collectMockedOllamaEvents(
  lines: string[],
  params: Parameters<typeof openStream>[0] = {},
): Promise<OllamaStreamEvent[]> {
  mockResponse(lines.join("\n") + "\n", { headers: ndjsonHeaders });
  return collectEvents(params);
}

function collectKimiEvents(messages: Partial<AssistantResponseMessage>[]) {
  return collectMockedOllamaEvents(
    [
      ...messages.map((message) => ndjson(message)),
      ndjson({}, { done: true, prompt_eval_count: 20, eval_count: 40 }),
    ],
    { model: { id: "kimi-k2.6:cloud", provider: "ollama" } },
  );
}

async function successfulOllamaRequest(params: Parameters<typeof openStream>[0]) {
  mockSuccess();
  const events = await collectEvents(params);
  expect(events.at(-1)?.type).toBe("done");
  return {
    body: requestBody(),
    request: requestCall(),
  };
}

describe("createOllamaStreamFn streaming events", () => {
  it("stops an already-aborted stream at the read boundary", async () => {
    mockSuccess();
    const signal = AbortSignal.abort();
    expect(await collectEvents({ options: { signal } })).toMatchObject([
      { type: "error", reason: "aborted" },
    ]);
  });

  it("reports the successful HTTP response before streaming events", async () => {
    const timeline: string[] = [];
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn((response, callbackModel) => {
      timeline.push("response");
      expect(response).toEqual({
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-ollama-request-id": "req-1",
        },
      });
      expect(callbackModel.id).toBe("qwen3:32b");
    });
    mockResponse(ndjson({ content: "ok" }) + "\n" + ndjson({}, { done: true }), {
      headers: { "Content-Type": "application/x-ndjson", "X-Ollama-Request-Id": "req-1" },
    });

    const stream = await openStream({
      options: withProviderAcceptanceObserver({ onResponse }, acceptanceObserver),
    });
    for await (const event of stream) {
      timeline.push(event.type);
    }

    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: { "content-type": "application/x-ndjson", "x-ollama-request-id": "req-1" },
    });
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(["response", "start", "text_start", "text_delta", "text_end", "done"]);
  });

  it("does not wait for unread response cancellation when the response hook fails", async () => {
    const source = createPendingCancelNdjsonStream([ndjson({ content: "ok" }, { done: true })]);
    source.reader.releaseLock();
    const release = mockResponse(source.stream);

    const stream = await openStream({
      options: {
        onResponse: () => {
          throw new Error("response hook failed");
        },
      },
    });
    const event = await stream[Symbol.asyncIterator]().next();
    await source.cancelStarted;
    source.settleCancel();
    await source.cancelPending;

    expect(event).toMatchObject({ done: false, value: { type: "error", reason: "error" } });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "resolving"] as const)(
    "aborts response handling while the hook is %s",
    async (phase) => {
      const hookStarted = Promise.withResolvers<void>();
      const hookPending = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>();
      const getReader = vi.spyOn(body, "getReader");
      const cancel = vi.spyOn(body, "cancel");
      const release = mockResponse(body);
      const caller = new AbortController();
      const eventsPromise = collectEvents({
        options: {
          onResponse: () => {
            hookStarted.resolve();
            return hookPending.promise;
          },
          signal: caller.signal,
        },
      });
      await hookStarted.promise;
      if (phase === "resolving") {
        await Promise.resolve();
        void hookPending.promise.then(() => caller.abort());
        hookPending.resolve();
      } else {
        caller.abort();
      }
      const events = await eventsPromise;
      expect(events).toMatchObject([{ type: "error", reason: "aborted" }]);
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "data after the terminal record",
      lines: [ndjson({ content: "done" }, { done: true }), ndjson({ content: "extra" })],
      error: undefined,
    },
    {
      name: "official streamed error with status metadata",
      lines: ['{"error":"model failed","status":503}'],
      error: {
        errorMessage: "503: model failed",
        errorCode: "503",
        errorBody: '{"error":"model failed","status":503}',
      },
    },
  ])("rejects $name", async ({ lines, error }) => {
    const events = await collectMockedOllamaEvents(lines);
    const types = events.map((event) => event.type);
    expect(types.at(-1)).toBe("error");
    expect(types).not.toContain("text_end");
    expect(types).not.toContain("done");
    if (error) {
      expect(types).toEqual(["error"]);
      expect(events[0]).toMatchObject({ type: "error", error });
    }
  });

  it("never exposes an intermediate native call invalidated by a later length terminal", async () => {
    const events = await collectMockedOllamaEvents([
      ndjson({ tool_calls: [bashCall] }),
      ndjson({}, { done: true, done_reason: "length" }),
    ]);

    expectEventTypes(events, "done");
    expect(events[0]).toMatchObject({
      type: "done",
      reason: "length",
      message: { content: [], stopReason: "length" },
    });
  });

  it("ends split Unicode text as soon as Ollama switches to tool calls", async () => {
    const chunks = ["Let me check. \ud83e", "\udd8a e", "\u0301"];
    const source = createControlledNdjsonFetch();
    const stream = await openStream({});
    const iterator = stream[Symbol.asyncIterator]();
    const text = chunks.join("");
    source.pushLine(ndjson({ content: chunks[0] }));
    await expectNext(iterator, { type: "start", partial: { content: [] } });
    await expectNext(iterator, { type: "text_start", contentIndex: 0, partial: { content: [] } });
    await expectNext(iterator, { type: "text_delta", contentIndex: 0, delta: chunks[0] });
    for (const content of chunks.slice(1)) {
      source.pushLine(ndjson({ content }));
      await expectNext(iterator, { type: "text_delta", contentIndex: 0, delta: content });
    }
    source.pushLine(ndjson({ tool_calls: [bashCall] }));
    await expectNext(iterator, {
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: { content: [{ type: "text", text }] },
    });
    source.pushLine(ndjson({}, { done: true }));
    source.close();
    const remaining = await Array.fromAsync(stream);
    expect(remaining).toMatchObject([
      { type: "toolcall_start", contentIndex: 1 },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"ls"}' },
      { type: "toolcall_end", contentIndex: 1 },
      {
        type: "done",
        reason: "toolUse",
        message: {
          content: [
            { type: "text", text },
            { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
    ]);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(source.release).toHaveBeenCalledOnce();
  });
  it("emits an error instead of accepting garbled Kimi visible text", async () => {
    const garbled =
      '$$"##"%#"##"####""$""""##""$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$' +
      '#"$"$"""$""""#$"""$"""%"%###"""#%""""&"#"""$"""#"#""""%#""""&"#"""$"""$"""#%"""';
    const events = await collectKimiEvents([{ content: garbled }]);
    expect(events).toMatchObject([
      { type: "error", error: { errorMessage: expect.stringContaining("garbled visible text") } },
    ]);
  });

  it("buffers Kimi inline reasoning until the streaming boundary is safe", async () => {
    vi.useFakeTimers();
    const source = createControlledNdjsonFetch();
    const stream = await openStream({
      model: { id: "kimi-k2.6:cloud", provider: "ollama" },
    });
    const iterator = stream[Symbol.asyncIterator]();
    source.pushLine(ndjson({ content: hiddenReasoning }));
    const started = vi.fn();
    const pendingStart = iterator.next().then((event) => {
      started();
      return event;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).not.toHaveBeenCalled();
    source.pushLine(ndjson({ content: " ️ OK." }));
    await expect(pendingStart).resolves.toMatchObject({ done: false, value: { type: "start" } });
    await expectNext(iterator, { type: "text_start", partial: { content: [] } });
    const delta = await iterator.next();
    expect(delta).toMatchObject({ done: false, value: { type: "text_delta", delta: "OK." } });
    expect(JSON.stringify(delta)).not.toContain(hiddenReasoning);
    source.pushLine(ndjson({}, { done: true }));
    source.close();
    const remaining = await Array.fromAsync(stream);
    expect(remaining).toMatchObject([
      { type: "text_end", content: "OK." },
      { type: "done", message: { content: [{ type: "text", text: "OK." }] } },
    ]);
    expect(JSON.stringify(remaining)).not.toContain(hiddenReasoning);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
  const bypassPrefix = "This Kimi cloud output has streamed past the sanitizer window. ".repeat(10);
  const visibleAnswer =
    "This visible answer is intentionally long enough to look like a reasoning prefix if it is sanitized a second time. ️ keep this marker visible.";
  it.each([
    {
      name: "bypassed sanitizer window",
      messages: [{ content: bypassPrefix }, { content: " ️ OK." }],
      text: `${bypassPrefix} ️ OK.`,
      appendOnly: true,
    },
    {
      name: "already sanitized output",
      messages: [{ content: `${hiddenReasoning} ️` }, { content: visibleAnswer }],
      text: visibleAnswer,
      appendOnly: false,
    },
    {
      name: "empty tool-call chunk",
      messages: [{ content: hiddenReasoning }, { tool_calls: [] }, { content: " ️ Visible answer" }],
      text: "Visible answer",
      appendOnly: false,
    },
  ])("keeps Kimi visible text after $name", async ({ name, messages, text, appendOnly }) => {
    const events = await collectKimiEvents(messages);
    if (appendOnly) {
      expectTextAppends(events, text);
    }
    expect(events.find((event) => event.type === "text_end")?.content).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text }] },
    });
    if (name === "empty tool-call chunk") {
      expectEventTypes(events, textEvents);
      expect(events[2]).toMatchObject({ type: "text_delta", delta: "Visible answer" });
      expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
    }
  });
  it.each([
    ["reasoning-only", `${hiddenReasoning} ️ `, ""],
    ["buffered visible text", "Visible answer", "Visible answer"],
  ])("flushes Kimi %s before native tool calls", async (_name, content, visible) => {
    const events = await collectKimiEvents([{ content }, { tool_calls: [bashCall] }]);
    expectEventTypes(
      events,
      `start ${visible ? "text_start text_delta text_end " : ""}toolcall_start toolcall_delta toolcall_end done`,
    );
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
    if (visible) {
      expect(events[2]).toMatchObject({ type: "text_delta", delta: "Visible answer" });
      expect(events[4]).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
      expect(events[6]).toMatchObject({ type: "toolcall_end", contentIndex: 1 });
    }
    const done = events.at(-1);
    assert(done?.type === "done", "Expected done event");
    expect(done.message.content).toEqual([
      ...(visible ? [{ type: "text", text: "Visible answer" }] : []),
      { type: "toolCall", id: expect.any(String), name: "bash", arguments: { command: "ls" } },
    ]);
  });
});

describe("createOllamaStreamFn", () => {
  it("preserves user and tool images for a vision model", async () => {
    const imageContent = (text: string, data: string) => [
      { type: "text", text },
      { type: "image", mimeType: "image/png", data },
    ];
    const context = {
      messages: [
        { role: "user", content: imageContent("user caption", "dXNlci1pbWFnZQ==") },
        {
          role: "toolResult",
          toolCallId: "call_inspect",
          toolName: "view_image",
          content: imageContent("tool caption", "dG9vbC1pbWFnZQ=="),
        },
      ],
    };
    const original = structuredClone(context);
    const { body } = await successfulOllamaRequest({
      model: { input: ["text", "image"] },
      context,
    });
    expect(body.messages).toMatchObject([
      { content: "user caption", images: ["dXNlci1pbWFnZQ=="] },
      {
        content: expect.stringContaining("tool caption"),
        images: ["dG9vbC1pbWFnZQ=="],
        tool_call_id: "call_inspect",
      },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain(
      "image omitted: model does not support images",
    );
    expect(context).toEqual(original);
  });

  it.each([
    {
      name: "keeps provider-shaped text response formats off the native Ollama wire",
      responseFormat: { type: "text" },
    },
    {
      name: "maps raw JSON Schema",
      responseFormat: replySchema,
      expectedFormat: replySchema,
    },
  ])("$name", async ({ responseFormat, expectedFormat }) => {
    const { body } = await successfulOllamaRequest({ options: { responseFormat } });
    expect(body.format).toEqual(expectedFormat);
  });

  it("normalizes native tool schemas and keeps their serialization stable across discovery order", async () => {
    const query = { anyOf: [{ type: "string" }, { type: "null" }] };
    const tags = { items: { type: "string" } };
    const tools = [
      {
        name: "search",
        description: "search",
        parameters: { properties: { query, tags }, required: ["query"] },
      },
      {
        name: "read",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const original = structuredClone(tools);
    const serialized: string[] = [];
    for (const orderedTools of [tools, tools.toReversed()]) {
      guardedFetch.mockClear();
      const { body } = await successfulOllamaRequest({
        context: { messages: [{ role: "user", content: "hello" }], tools: orderedTools },
        options: { responseFormat: replySchema },
      });
      expect(body.tools).toEqual([
        { type: "function", function: tools[1] },
        {
          type: "function",
          function: {
            ...tools[0],
            parameters: {
              type: "object",
              properties: { query: { ...query, type: "string" }, tags: { ...tags, type: "array" } },
              required: ["query"],
            },
          },
        },
      ]);
      expect(body).not.toHaveProperty("format");
      serialized.push(JSON.stringify(body.tools));
    }
    expect(serialized[1]).toBe(serialized[0]);
    expect(tools).toEqual(original);
  });

  const runtimeOptions = {
    temperature: 0.7,
    maxTokens: 55,
    topP: 0,
    seed: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stop: ["REQUEST"],
  };
  it.each`
    name                        | numCtx   | options                          | context  | temperature | topP   | seed | frequency | presence | stop
    ${"configured options"}     | ${0}     | ${{ stop: [] }}                  | ${16384} | ${0.8}      | ${0.9} | ${7} | ${0.5}    | ${0.75}  | ${"MODEL"}
    ${"runtime zero overrides"} | ${32768} | ${runtimeOptions}                | ${32768} | ${0.7}      | ${0}   | ${0} | ${0}      | ${0}     | ${"REQUEST"}
    ${"greedy normalization"}   | ${32768} | ${{ temperature: 0, topP: 0.6 }} | ${32768} | ${0}        | ${1}   | ${7} | ${0.5}    | ${0.75}  | ${"MODEL"}
  `(
    "maps native request options: $name",
    async ({ numCtx, options, context, temperature, topP, seed, frequency, presence, stop }) => {
      const { body } = await successfulOllamaRequest({
        model: {
          contextWindow: 131072,
          contextTokens: 16384,
          params: {
            num_ctx: numCtx,
            temperature: 0.8,
            top_p: 0.9,
            seed: 7,
            frequency_penalty: 0.5,
            presence_penalty: 0.75,
            stop: ["MODEL"],
            thinking: false,
            streaming: false,
            truncate: true,
            shift: true,
          },
        },
        options,
      });
      expect(body.options).toMatchObject({
        num_ctx: context,
        temperature,
        top_p: topP,
        seed,
        frequency_penalty: frequency,
        presence_penalty: presence,
        stop: [stop],
      });
      if ("maxTokens" in options) {
        expect(requireRecord(body.options, "options").num_predict).toBe(55);
      }
      expect(body.options).not.toHaveProperty("streaming");
      expect(body).toMatchObject({ think: false, truncate: true, shift: true });
    },
  );

  it("uses the default loopback policy when baseUrl is empty", async () => {
    const { request } = await successfulOllamaRequest({ baseUrl: "" });
    expect(request.url).toBe("http://127.0.0.1:11434/api/chat");
    const policy = requireRecord(request.policy, "ssrf policy");
    expect(policy.hostnameAllowlist).toEqual(["127.0.0.1"]);
    expect(policy.allowPrivateNetwork).toBe(true);
  });

  it("redacts a configured header prefix split by the 8 KiB error cap", async () => {
    const configuredSecret = "stream-boundary-credential-secret";
    const retainedPrefix = configuredSecret.slice(0, -5);
    const safeMarker = "bounded stream diagnostic: ";
    const tracked = cancelTrackedTextResponse(
      `${safeMarker}${"x".repeat(8 * 1024 - safeMarker.length - retainedPrefix.length)}${configuredSecret} trailing text`,
      { status: 503, statusText: "Service Unavailable" },
    );
    guardedFetch.mockResolvedValue({
      response: tracked.response,
      release: vi.fn(async () => undefined),
    });
    const timeline: string[] = [];
    const onResponse = vi.fn(() => {
      timeline.push("response");
    });
    const stream = await openStream({
      defaultHeaders: { "X-Proxy-Auth": configuredSecret },
      options: { onResponse },
    });
    const events: OllamaStreamEvent[] = [];
    for await (const event of stream) {
      timeline.push(event.type);
      events.push(event);
    }
    expect(timeline).toEqual(["response", "error"]);
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
      expect.objectContaining({ id: "qwen3:32b" }),
    );
    const errorEvent = expectDefined(
      events.find((event) => event.type === "error"),
      "Ollama error event",
    );

    const message = errorEvent.error.errorMessage ?? "";
    expect(message).toMatch(/^503\b/);
    expect(message).toContain(safeMarker);
    expect(message).not.toContain(retainedPrefix);
    expect(message).not.toContain(configuredSecret);
    expect(message).not.toContain("trailing text");
    expect(tracked.wasCanceled()).toBe(true);
  });
});

describe("createConfiguredOllamaStreamFn", () => {
  it("routes a remote model endpoint without acquiring the local service", async () => {
    const acquire = vi.fn(async () => ({ release: vi.fn() }));
    const { request } = await successfulOllamaRequest({
      model: { provider: "ollama-gpu" },
      configured: {
        model: { baseUrl: "https://remote-ollama.example.test" },
        providerBaseUrl: undefined,
        localService: { providerId: "ollama-gpu", acquire },
      },
      options: {},
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(request.url).toBe("https://remote-ollama.example.test/api/chat");
  });

  it("acquires the exact provider after payload preparation and releases it after fetch cleanup", async () => {
    const signal = new AbortController().signal;
    const payloadStarted = Promise.withResolvers<void>();
    const finishPayload = Promise.withResolvers<void>();
    const order: string[] = [];
    const acquire = vi.fn(async () => {
      order.push("acquire");
      return {
        release: () => {
          order.push("lease release");
        },
      };
    });
    guardedFetch.mockImplementation(async () => {
      order.push("fetch");
      return {
        response: new Response(successBody),
        release: async () => {
          order.push("guard release");
        },
      };
    });
    const events = collectManaged({
      providerId: "ollama-gpu",
      defaultHeaders: { "X-Provider": "provider", Authorization: "Bearer proxy-token" },
      options: {
        apiKey: "real-token", // pragma: allowlist secret
        headers: { "X-Request": "request" },
        signal,
        onPayload: async (payload) => {
          payloadStarted.resolve();
          await finishPayload.promise;
          order.push("payload ready");
          return { ...requireRecord(payload, "payload"), model: "patched" };
        },
      },
      acquire,
    });
    try {
      await payloadStarted.promise;
      expect(order).toEqual([]);
    } finally {
      finishPayload.resolve();
      await events;
    }
    expect(acquire).toHaveBeenCalledWith(
      {
        providerId: "ollama-gpu",
        baseUrl: "http://provider-host:11434",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer real-token",
          "X-Provider": "provider",
          "X-Request": "request",
        },
      },
      signal,
    );
    expect(requestBody().model).toBe("patched");
    expect(order).toEqual(["payload ready", "acquire", "fetch", "guard release", "lease release"]);
  });

  it.each(["timeout", "caller abort"] as const)(
    "stops pending acquisition on %s before fetch",
    async (ending) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      let acquisitionSignal: AbortSignal | undefined;
      const acquire = vi.fn((_request, signal) => {
        const currentSignal = expectDefined(signal, "acquisition signal");
        acquisitionSignal = currentSignal;
        return rejectWhenAborted(currentSignal);
      });
      const eventsPromise = collectManaged({
        model: { requestTimeoutMs: ending === "timeout" ? 25 : 5_000 },
        options: ending === "timeout" ? undefined : { signal: caller.signal },
        acquire,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalledOnce();
      if (ending === "timeout") {
        await vi.advanceTimersByTimeAsync(25);
        expect(acquisitionSignal?.reason).toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
        expect(await eventsPromise).toMatchObject([
          { type: "error", reason: "error", error: { errorMessage: "request timed out" } },
        ]);
      } else {
        const reason = new Error("caller stopped");
        caller.abort(reason);
        expect(acquisitionSignal?.reason).toBe(reason);
        expect(await eventsPromise).toMatchObject([{ type: "error", reason: "aborted" }]);
      }
      expect(guardedFetch).not.toHaveBeenCalled();
    },
  );

  it("cleans the acquisition timer before a long progressing stream", async () => {
    vi.useFakeTimers();
    const source = createControlledNdjsonFetch();
    let acquisitionSignal: AbortSignal | undefined;
    const acquire = vi.fn(async (_request, signal) => {
      acquisitionSignal = expectDefined(signal, "acquisition timeout signal");
      return { release: vi.fn() };
    });
    const eventsPromise = collectManaged({ model: { requestTimeoutMs: 25 }, acquire });
    await vi.advanceTimersByTimeAsync(0);
    expect(guardedFetch).toHaveBeenCalledOnce();
    expect(requestCall()).toMatchObject({ timeoutMs: 25 });
    expect(requestCall().signal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(acquisitionSignal?.aborted).toBe(false);
    source.pushLine(ndjson({ content: "partial" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(source.refreshTimeout).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(acquisitionSignal?.aborted).toBe(false);
    source.pushLine(ndjson({}, { done: true }));
    source.close();
    expect((await eventsPromise).at(-1)).toMatchObject({ type: "done" });
    expect(source.refreshTimeout).toHaveBeenCalledTimes(2);
  });
  it("holds the local-service lease through incomplete NDJSON handling", async () => {
    const source = createControlledNdjsonFetch();
    const leaseRelease = vi.fn();
    const acquire = vi.fn(async () => ({ release: leaseRelease }));
    const stream = await openManaged({ acquire });
    const iterator = stream[Symbol.asyncIterator]();
    source.pushLine(ndjson({ content: "partial" }));
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "start" } });
    expect(leaseRelease).not.toHaveBeenCalled();
    source.close();
    const events = await Array.fromAsync(stream);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: OLLAMA_INCOMPLETE_STREAM_ERROR },
    });
    expect(source.release).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
  });
  it.each(["empty body", "fetch rejection"] as const)(
    "releases the service exactly once after %s",
    async (failure) => {
      const leaseRelease = vi.fn();
      const acquire = vi.fn(async () => ({ release: leaseRelease }));
      const guardRelease = failure === "empty body" ? mockResponse(null) : undefined;
      if (failure === "fetch rejection") {
        guardedFetch.mockRejectedValue(
          Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
        );
      }
      const events = await collectManaged({ acquire });
      expect(acquire).toHaveBeenCalledOnce();
      expect(leaseRelease).toHaveBeenCalledOnce();
      expect(events).toMatchObject([{ type: "error" }]);
      if (guardRelease) {
        expect(guardRelease).toHaveBeenCalledOnce();
      } else {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "error",
          reason: "error",
          error: { errorMessage: "connect failed", errorCode: "ECONNREFUSED" },
        });
      }
    },
  );

  it("does not acquire or fetch after payload serialization failure", async () => {
    const acquire = vi.fn(async () => ({ release: vi.fn() }));
    const events = await collectManaged({ options: { onPayload: () => ({ value: 1n }) }, acquire });
    expect(events).toMatchObject([{ type: "error", reason: "error" }]);
    expect(acquire).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
