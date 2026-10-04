import { expectDefined } from "@openclaw/normalization-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { Model } from "openclaw/plugin-sdk/llm";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { OLLAMA_INCOMPLETE_STREAM_ERROR } from "./stream-contract.js";
import {
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  convertToOllamaMessages,
  buildAssistantMessage,
  parseNdjsonStream,
} from "./stream.runtime.js";

type GuardedFetchCall = Parameters<typeof fetchWithSsrFGuard>[0];

const requireRecord = createRequireRecord("object", "expected-label");

function convertAssistantContent(
  content: Array<Record<string, unknown>>,
  options?: Parameters<typeof convertToOllamaMessages>[2],
) {
  return convertToOllamaMessages([{ role: "assistant", content }] as never, undefined, options);
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

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});

async function compatPayload(
  id: string,
  params: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const model: Model = {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://ollama-host:11434",
    input: ["text"],
    reasoning: true,
    contextWindow: 262144,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    params,
  };
  let patched: unknown;
  const wrapped = expectDefined(
    createConfiguredOllamaCompatStreamWrapper({
      provider: "ollama",
      modelId: id,
      model,
      thinkingLevel: "high",
      streamFn: (_model, _context, options) => {
        options?.onPayload?.(payload, model);
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
  return requireRecord(patched, "patched payload");
}

describe("createConfiguredOllamaCompatStreamWrapper", () => {
  it("builds a bare request with default streaming and an unprefixed model id", () => {
    expect(buildOllamaChatRequest({ modelId: "ollama/qwen3", messages: [] })).toEqual({
      model: "qwen3",
      messages: [],
      stream: true,
    });
  });

  it("adds Moonshot thinking config for Ollama cloud Kimi compat requests", async () => {
    const payload = await compatPayload(
      "kimi-k2.5:cloud",
      { num_ctx: 65536 },
      { tool_choice: "auto" },
    );
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.options).toEqual({ num_ctx: 65536 });
  });

  it("preserves OpenAI-compatible replay tool arguments as strings", async () => {
    const payload = await compatPayload(
      "glm-5.2:cloud",
      { num_ctx: 0 },
      {
        messages: [
          {
            role: "assistant",
            function_call: { name: "legacy_gateway", arguments: '{"action":"config.get"}' },
            tool_calls: [
              {
                id: "call_gateway",
                type: "function",
                function: {
                  name: "gateway",
                  arguments: '{"action":"config.get","path":"gateway.port"}',
                },
              },
            ],
          },
        ],
      },
    );
    expect(payload.messages).toEqual([
      {
        role: "assistant",
        function_call: { name: "legacy_gateway", arguments: '{"action":"config.get"}' },
        tool_calls: [
          {
            id: "call_gateway",
            type: "function",
            function: {
              name: "gateway",
              arguments: '{"action":"config.get","path":"gateway.port"}',
            },
          },
        ],
      },
    ]);
    expect(payload.options).toEqual({ num_ctx: 262144 });
  });

  it.each([
    ["off", "off", {}, false],
    ["configured", "off", { params: { thinking: "medium" } }, "medium"],
    [
      "non-reasoning configured",
      "off",
      { params: { thinking: "medium" }, reasoning: false },
      undefined,
    ],
    ["non-reasoning runtime", "low", { reasoning: false }, undefined],
    ["native low", "low", {}, "low"],
    ["native high", "high", {}, "high"],
    ["local max fallback", "max", {}, "high"],
    ["cloud max", "max", { provider: "ollama-cloud", id: "glm-5.2" }, "max"],
    ["new cloud max", "max", { provider: "ollama-cloud", id: "glm-5.3" }, "max"],
    [
      "new cloud configured max",
      "off",
      { provider: "ollama-cloud", id: "glm-5.3", params: { thinking: "max" } },
      "max",
    ],
    ["cloud max fallback", "max", { provider: "ollama-cloud", id: "kimi-k2.5" }, "high"],
  ] as const)(
    "forwards native thinking: %s",
    async (_name, thinkingLevel, overrides, expectedThink) => {
      await withSuccessfulOllamaFetch(async (fetchMock) => {
        const model = {
          api: "ollama",
          provider: "ollama",
          id: "qwen3:32b",
          input: ["text"],
          contextWindow: 131072,
          ...overrides,
        };
        const wrapped = expectDefined(
          createConfiguredOllamaCompatStreamWrapper({
            provider: model.provider,
            modelId: model.id,
            model,
            streamFn: createOllamaStreamFn("http://ollama-host:11434"),
            thinkingLevel,
          } as never),
          "wrapped Ollama stream function",
        );
        await collectStreamEvents(
          await wrapped(
            model as never,
            { messages: [{ role: "user", content: "hello" }] } as never,
            {},
          ),
        );
        const body = getGuardedFetchJsonBody(fetchMock);
        expect(body.think).toBe(expectedThink);
        expect(body.options).not.toHaveProperty("think");
        expect(body.options).not.toHaveProperty("num_ctx");
      });
    },
  );

  it("sends custom-provider Ollama chat requests with the bare Ollama model id", async () => {
    await expectSuccessfulOllamaRequest(
      {
        model: { provider: "ollama-spark", id: "ollama-spark/qwen3:32b" },
      },
      ({ body }) => expect(body.model).toBe("qwen3:32b"),
    );
  });
});

describe("convertToOllamaMessages", () => {
  it("accepts legacy string tool messages without inventing call metadata", () => {
    expect(convertToOllamaMessages([{ role: "tool", content: "output" }])).toEqual([
      { role: "tool", content: "output" },
    ]);
  });

  it("prepends system message when provided", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = convertToOllamaMessages(messages, "You are helpful.");
    expect(result[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(result[1]).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("preserves assistant thinking alongside text and tool calls", () => {
    const result = convertAssistantContent([
      { type: "thinking", thinking: "Check the directory.\n" },
      { type: "thinking", thinking: "Then report its contents." },
      { type: "thinking", thinking: "redacted reasoning", redacted: true },
      { type: "text", text: "Let me check." },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "Let me check.",
      thinking: "Check the directory.\nThen report its contents.",
      tool_calls: [{ id: "call_1", function: { name: "bash", arguments: { command: "ls" } } }],
    });
  });

  it("normalizes provider-prefixed tool-call names before Ollama replay", () => {
    const result = convertAssistantContent([
      { type: "toolCall", id: "call_1", name: "functions.exec", arguments: { command: "pwd" } },
      { type: "tool_use", id: "call_2", name: "tools/read", input: '{"path":"README.md"}' },
      { type: "toolCall", id: "call_3", name: "tool_a", arguments: {} },
    ]);
    expect(result[0]?.tool_calls).toEqual([
      { id: "call_1", function: { name: "exec", arguments: { command: "pwd" } } },
      { id: "call_2", function: { name: "read", arguments: { path: "README.md" } } },
      { id: "call_3", function: { name: "tool_a", arguments: {} } },
    ]);
  });

  it("strips underscore and dash provider prefixes only when the suffix is allowlisted", () => {
    const result = convertAssistantContent(
      [
        { type: "toolCall", id: "call_1", name: "tools_exec", arguments: { command: "pwd" } },
        { type: "tool_use", id: "call_2", name: "function-read", input: { path: "." } },
        { type: "toolCall", id: "call_3", name: "tool_missing", arguments: {} },
        { type: "toolCall", id: "call_4", name: "tool_a", arguments: {} },
      ],
      {
        availableToolNames: new Set(["exec", "read", "tool_a"]),
      },
    );
    expect(result[0]?.tool_calls).toEqual([
      { id: "call_1", function: { name: "exec", arguments: { command: "pwd" } } },
      { id: "call_2", function: { name: "read", arguments: { path: "." } } },
      { id: "call_3", function: { name: "tool_missing", arguments: {} } },
      { id: "call_4", function: { name: "tool_a", arguments: {} } },
    ]);
  });

  it("preserves unsafe integers as strings when replay args are deserialized", () => {
    const result = convertAssistantContent([
      {
        type: "toolCall",
        id: "call_3",
        name: "read",
        arguments: '{"path":9223372036854775807,"nested":{"thread":1234567890123456789}}',
      },
    ]);
    expect(result[0]?.tool_calls).toEqual([
      {
        id: "call_3",
        function: {
          name: "read",
          arguments: {
            path: "9223372036854775807",
            nested: { thread: "1234567890123456789" },
          },
        },
      },
    ]);
  });
  it.each([
    `${"file row with significant trailing spaces   \n".repeat(370)}😀\n[Use offset=225 to continue.]\n`,
  ])("preserves producer-budgeted tool text and continuation on the Ollama wire: %#", (text) => {
    const result = convertToOllamaMessages([
      {
        role: "toolResult",
        toolCallId: "call_ws",
        toolName: "read",
        content: [{ type: "text", text }],
      },
    ]);
    expect(result).toEqual([
      { role: "tool", content: text, tool_call_id: "call_ws", tool_name: "read" },
    ]);
  });

  it("preserves structured, image, error, and call identity in tool results", () => {
    const result = convertToOllamaMessages([
      {
        role: "toolResult",
        toolCallId: "call_inspect",
        toolName: "inspect",
        isError: true,
        content: [
          { type: "text", text: "inspection failed" },
          { type: "json", value: { retry: false } },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "tool",
        content:
          '[tool error] inspection failed\n{"type":"json","value":{"retry":false}}\n[unsupported tool-result audio omitted]',
        images: ["aW1hZ2U="],
        tool_call_id: "call_inspect",
        tool_name: "inspect",
      },
    ]);
    expect(result[0]?.content).not.toContain("YXVkaW8=");

    expect(
      convertToOllamaMessages([
        {
          role: "toolResult",
          toolCallId: "call_empty_error",
          toolName: "inspect",
          isError: true,
          content: [],
        },
      ])[0],
    ).toMatchObject({
      content: "[tool error] (no tool output)",
      tool_call_id: "call_empty_error",
    });
  });
});

describe("buildAssistantMessage", () => {
  const modelInfo = { api: "ollama", provider: "ollama", id: "qwen3:32b" };

  it("keeps reasoning-only output when content and thinking are empty", () => {
    const response = createAssistantResponse({ content: "", reasoning: "Reasoning output" });
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "thinking", thinking: "Reasoning output" }]);
  });

  it("strips inline reasoning for provider-qualified Kimi cloud refs", () => {
    expect(
      buildAssistantMessage(createAssistantResponse({ content: `${hiddenReasoning} ️ OK.` }), {
        api: "ollama",
        provider: "ollama",
        id: "ollama/kimi-k2.6:cloud",
      }).content,
    ).toEqual([{ type: "text", text: "OK." }]);
  });

  it("does not treat emoji variation selectors as Kimi inline-reasoning boundaries", () => {
    const response = createAssistantResponse(
      {
        content:
          "This is a normal Kimi cloud answer with enough length to cross the prefix threshold and no hidden reasoning leak. ☀️sunshine should remain visible to the user.",
      },
      { model: "kimi-k2.6:cloud" },
    );
    const result = buildAssistantMessage(response, {
      api: "ollama",
      provider: "ollama",
      id: "kimi-k2.6:cloud",
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "This is a normal Kimi cloud answer with enough length to cross the prefix threshold and no hidden reasoning leak. ☀️sunshine should remain visible to the user.",
      },
    ]);
  });

  it.each([0, 6])(
    "accounts for %s cached prompt tokens without changing the total",
    (cacheRead) => {
      const response = createAssistantResponse(
        { content: "ok" },
        {
          prompt_eval_count: 10,
          prompt_eval_cached_count: cacheRead,
          eval_count: 2,
        },
      );
      const result = buildAssistantMessage(response, modelInfo);
      expect(result.usage).toMatchObject({
        input: 10 - cacheRead,
        output: 2,
        cacheRead,
        cacheWrite: 0,
        totalTokens: 12,
        cacheTelemetry: { state: "available" },
      });
    },
  );
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
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"one"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"two"},"done":true}',
    ]);
    let iterationFinished = false;

    const iteration = (async () => {
      for await (const chunk of parseNdjsonStream(source.reader)) {
        expect(chunk.message.content).toBe("one");
        break;
      }
      iterationFinished = true;
    })();

    await source.cancelStarted;
    await iteration;
    expect(iterationFinished).toBe(true);
    expect(source.stream.locked).toBe(false);

    source.settleCancel();
    await source.cancelPending;
  });
});

function mockResponse(body: BodyInit | null, init?: ResponseInit) {
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValue({ response: new Response(body, init), release });
  return release;
}

async function withSuccessfulOllamaFetch(
  run: (fetchMock: typeof fetchWithSsrFGuardMock) => Promise<void>,
): Promise<void> {
  mockResponse(
    [
      ndjson({ content: "ok" }),
      ndjson({}, { done: true, prompt_eval_count: 1, eval_count: 1 }),
    ].join("\n") + "\n",
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
  await run(fetchWithSsrFGuardMock);
}

function createControlledNdjsonFetch() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const release = vi.fn(async () => undefined);
  const refreshTimeout = vi.fn();
  return {
    release,
    refreshTimeout,
    fetchImpl: async () => ({
      response: new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
      release,
      refreshTimeout,
    }),
    pushLine(line: string) {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.enqueue(encoder.encode(`${line}\n`));
    },
    close() {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.close();
    },
  };
}

function getGuardedFetchCall(fetchMock: typeof fetchWithSsrFGuardMock): GuardedFetchCall {
  return (fetchMock.mock.calls.at(0)?.[0] as GuardedFetchCall | undefined) ?? { url: "" };
}

function getGuardedFetchJsonBody(
  fetchMock: typeof fetchWithSsrFGuardMock,
): Record<string, unknown> {
  const body = getGuardedFetchCall(fetchMock).init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected string request body");
  }
  return requireRecord(JSON.parse(body), "Ollama request body");
}

async function createOllamaTestStream(
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

async function createManagedOllamaTestStream(params: {
  baseUrl?: string;
  providerId?: string;
  defaultHeaders?: Record<string, string>;
  model?: Record<string, unknown>;
  context?: Record<string, unknown>;
  options?: Parameters<ReturnType<typeof createConfiguredOllamaStreamFn>>[2];
  acquire: OllamaLocalService["acquire"];
}) {
  const baseUrl = params.baseUrl ?? "http://provider-host:11434";
  return createOllamaTestStream({
    ...params,
    baseUrl,
    model: { provider: params.providerId ?? "custom-ollama", ...params.model },
    configured: {
      model: { baseUrl, headers: params.defaultHeaders },
      providerBaseUrl: baseUrl,
      localService: { providerId: params.providerId ?? "custom-ollama", acquire: params.acquire },
    },
  });
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

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

type OllamaStreamEvent =
  Awaited<ReturnType<typeof createOllamaTestStream>> extends AsyncIterable<infer Event>
    ? Event
    : never;

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
  params: Parameters<typeof createOllamaTestStream>[0] = {},
): Promise<OllamaStreamEvent[]> {
  mockResponse(lines.join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  return collectStreamEvents(await createOllamaTestStream(params));
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

async function expectSuccessfulOllamaRequest(
  params: Parameters<typeof createOllamaTestStream>[0],
  verify: (observation: {
    body: Record<string, unknown>;
    fetchMock: typeof fetchWithSsrFGuardMock;
    request: GuardedFetchCall;
  }) => void | Promise<void>,
): Promise<void> {
  await withSuccessfulOllamaFetch(async (fetchMock) => {
    const events = await collectStreamEvents(await createOllamaTestStream(params));
    expect(events.at(-1)?.type).toBe("done");
    await verify({
      body: getGuardedFetchJsonBody(fetchMock),
      fetchMock,
      request: getGuardedFetchCall(fetchMock),
    });
  });
}

describe("createOllamaStreamFn streaming events", () => {
  it("stops an already-aborted stream at the read boundary", async () => {
    await withSuccessfulOllamaFetch(async () => {
      const signal = AbortSignal.abort();
      expect(
        await collectStreamEvents(await createOllamaTestStream({ options: { signal } })),
      ).toMatchObject([{ type: "error", reason: "aborted" }]);
    });
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

    const stream = await createOllamaTestStream({
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
    const source = createPendingCancelNdjsonStream([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":true}',
    ]);
    source.reader.releaseLock();
    const release = mockResponse(source.stream);

    const stream = await createOllamaTestStream({
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

  it("stops waiting for the response hook when the request is aborted", async () => {
    const { promise: hookStarted, resolve: markHookStarted } = Promise.withResolvers<void>();
    const onResponse = vi.fn(async () => {
      markHookStarted();
      await new Promise<void>(() => {
        // Keep the hook pending so the request signal must end the stream.
      });
    });
    const release = mockResponse(ndjson({ content: "ok" }, { done: true }));
    const abortController = new AbortController();

    const eventsPromise = collectStreamEvents(
      await createOllamaTestStream({
        options: { onResponse, signal: abortController.signal },
      }),
    );
    await hookStarted;
    abortController.abort();
    const events = await eventsPromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not resume response handling after the hook resolves concurrently with abort", async () => {
    const { promise: hookStarted, resolve: markHookStarted } = Promise.withResolvers<void>();
    const { promise: hookPending, resolve: settleHook } = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>();
    const getReader = vi.spyOn(body, "getReader");
    const cancel = vi.spyOn(body, "cancel");
    const release = mockResponse(body);
    const abortController = new AbortController();

    const eventsPromise = collectStreamEvents(
      await createOllamaTestStream({
        options: {
          onResponse: () => {
            markHookStarted();
            return hookPending;
          },
          signal: abortController.signal,
        },
      }),
    );
    await hookStarted;
    await Promise.resolve();
    void hookPending.then(() => abortController.abort());
    settleHook();
    const events = await eventsPromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails the full stream for malformed terminal tool arguments", async () => {
    const events = await collectMockedOllamaEvents([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_valid","function":{"name":"read","arguments":{"path":"README.md"}}},{"id":"call_invalid","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\""}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
    ]);

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { errorMessage: "Provider completed tool call with malformed JSON arguments" },
    });
  });

  it("fails when data trails a terminal Ollama record", async () => {
    const events = await collectMockedOllamaEvents([
      ndjson({ content: "done" }, { done: true }),
      ndjson({ content: "extra" }),
    ]);
    const types = events.map((event) => event.type);
    expect(types.at(-1)).toBe("error");
    expect(types).not.toContain("text_end");
    expect(types).not.toContain("done");
  });

  it("projects official streamed Ollama error records with status metadata", async () => {
    const events = await collectMockedOllamaEvents(['{"error":"model failed","status":503}']);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: {
        errorMessage: "503: model failed",
        errorCode: "503",
        errorBody: '{"error":"model failed","status":503}',
      },
    });
  });

  it("counts image payloads in prompt usage estimates when Ollama omits counters", async () => {
    const events = await collectMockedOllamaEvents(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"vision answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
      ],
      {
        model: { id: "llava", input: ["text", "image"] },
        context: {
          messages: [{ role: "user", content: [{ type: "image", data: "a".repeat(400) }] }],
        },
      },
    );
    const doneEvent = events.at(-1);
    expect(doneEvent?.type).toBe("done");
    if (doneEvent?.type === "done") {
      expect(doneEvent.message.usage.input).toBeGreaterThan(50);
    }
  });

  it("streams multiple native calls with stable provider ids across chunks", async () => {
    const events = await collectMockedOllamaEvents([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"id":"call-read","function":{"name":"read","arguments":{"path":"/tmp/a","target":1234567890123456789,"nested":{"thread":9223372036854775807}}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"id":"call-bash","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\",\\"target\\":9223372036854775807}"}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const toolCallEnds = events.filter((event) => event.type === "toolcall_end");
    expect(toolCallEnds).toMatchObject([
      {
        contentIndex: 0,
        toolCall: {
          id: "call-read",
          name: "read",
          arguments: {
            path: "/tmp/a",
            target: "1234567890123456789",
            nested: { thread: "9223372036854775807" },
          },
        },
      },
      {
        contentIndex: 1,
        toolCall: {
          id: "call-bash",
          name: "bash",
          arguments: { command: "ls", target: "9223372036854775807" },
        },
      },
    ]);
    expect(events.filter((event) => event.type === "toolcall_delta")).toMatchObject([
      {
        contentIndex: 0,
        delta:
          '{"path":"/tmp/a","target":"1234567890123456789","nested":{"thread":"9223372036854775807"}}',
      },
      { contentIndex: 1, delta: '{"command":"ls","target":"9223372036854775807"}' },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toMatchObject([
      { partial: { content: [{ arguments: {} }] } },
      {
        partial: {
          content: [{ arguments: { path: "/tmp/a" } }, { arguments: {} }],
        },
      },
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") {
      throw new Error("missing terminal Ollama message");
    }
    expect(done.message.content).toMatchObject([
      { type: "toolCall", id: "call-read" },
      { type: "toolCall", id: "call-bash" },
    ]);
  });

  it("never exposes an intermediate native call invalidated by a later length terminal", async () => {
    const events = await collectMockedOllamaEvents([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"done_reason":"length"}',
    ]);

    expect(events.map((event) => event.type)).toEqual(["done"]);
    expect(events[0]).toMatchObject({
      type: "done",
      reason: "length",
      message: { content: [], stopReason: "length" },
    });
  });

  it("emits text_end as soon as Ollama switches from text to tool calls", async () => {
    const source = createControlledNdjsonFetch();
    fetchWithSsrFGuardMock.mockImplementation(source.fetchImpl);
    const stream = await createOllamaTestStream({});
    const iterator = stream[Symbol.asyncIterator]();
    source.pushLine(ndjson({ content: "Let me check." }));
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "start", partial: { content: [] } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_start", partial: { content: [] } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", delta: "Let me check." },
    });
    source.pushLine(
      ndjson({ tool_calls: [{ function: { name: "bash", arguments: { command: "ls" } } }] }),
    );
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: "text_end",
        contentIndex: 0,
        content: "Let me check.",
        partial: { content: [{ type: "text", text: "Let me check." }] },
      },
    });
    source.pushLine(ndjson({}, { done: true }));
    source.close();
    const remaining = await collectStreamEvents(stream);
    expect(remaining.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(remaining[1]).toMatchObject({ type: "toolcall_delta", delta: '{"command":"ls"}' });
    expect(remaining.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
  it("emits an error instead of accepting garbled Kimi visible text", async () => {
    const garbled =
      '$$"##"%#"##"####""$""""##""$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$' +
      '#"$"$"""$""""#$"""$"""%"%###"""#%""""&"#"""$"""#"#""""%#""""&"#"""$"""$"""#%"""';
    const events = await collectKimiEvents([{ content: garbled }]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["error"]);
    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe("error");
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.errorMessage).toContain("garbled visible text");
    }
  });

  it("buffers Kimi inline reasoning until the streaming boundary is safe", async () => {
    vi.useFakeTimers();
    try {
      const source = createControlledNdjsonFetch();
      fetchWithSsrFGuardMock.mockImplementation(source.fetchImpl);
      const stream = await createOllamaTestStream({
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
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: "text_start", partial: { content: [] } },
      });
      const delta = await iterator.next();
      expect(delta).toMatchObject({ done: false, value: { type: "text_delta", delta: "OK." } });
      expect(JSON.stringify(delta)).not.toContain(hiddenReasoning);
      source.pushLine(ndjson({}, { done: true }));
      source.close();
      const remaining = await collectStreamEvents(stream);
      expect(remaining.map((event) => event.type)).toEqual(["text_end", "done"]);
      expect(remaining[0]).toMatchObject({ content: "OK." });
      expect(remaining[1]).toMatchObject({ message: { content: [{ type: "text", text: "OK." }] } });
      expect(JSON.stringify(remaining)).not.toContain(hiddenReasoning);
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps Kimi deltas append-only after the bounded sanitizer window is bypassed", async () => {
    const prefix = "This Kimi cloud output has streamed past the sanitizer window. ".repeat(10);
    const events = await collectKimiEvents([{ content: prefix }, { content: " ️ OK." }]);
    const text = `${prefix} ️ OK.`;
    expectTextAppends(events, text);
    expect(events.find((event) => event.type === "text_end")?.content).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text }] },
    });
  });
  it("does not re-sanitize visible Kimi stream output before done", async () => {
    const text =
      "This visible answer is intentionally long enough to look like a reasoning prefix if it is sanitized a second time. ️ keep this marker visible.";
    const events = await collectKimiEvents([{ content: `${hiddenReasoning} ️` }, { content: text }]);
    expect(events.find((event) => event.type === "text_end")?.content).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: [{ type: "text", text }] },
    });
  });
  it("does not leak Kimi inline reasoning when a boundary is followed by tool calls only", async () => {
    const events = await collectKimiEvents([
      { content: `${hiddenReasoning} ️ ` },
      { tool_calls: [{ function: { name: "bash", arguments: { command: "ls" } } }] },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
    const done = events.at(-1);
    if (done?.type !== "done") {
      throw new Error("Expected done event");
    }
    expect(done.message.content).toEqual([
      { type: "toolCall", id: expect.any(String), name: "bash", arguments: { command: "ls" } },
    ]);
  });
  it("flushes buffered visible Kimi text before streaming its native tool call", async () => {
    const events = await collectKimiEvents([
      { content: "Visible answer" },
      { tool_calls: [{ function: { name: "bash", arguments: { command: "ls" } } }] },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events[2]).toMatchObject({ type: "text_delta", delta: "Visible answer" });
    expect(events[4]).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
    expect(events[6]).toMatchObject({ type: "toolcall_end", contentIndex: 1 });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [
          { type: "text", text: "Visible answer" },
          { type: "toolCall", name: "bash" },
        ],
      },
    });
  });
  it("does not reveal buffered Kimi reasoning for an empty tool-call chunk", async () => {
    const events = await collectKimiEvents([
      { content: hiddenReasoning },
      { tool_calls: [] },
      { content: " ️ Visible answer" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events[2]).toMatchObject({ type: "text_delta", delta: "Visible answer" });
    expect(JSON.stringify(events)).not.toContain(hiddenReasoning);
  });
});

describe("createOllamaStreamFn", () => {
  it("preserves user and tool images for a vision model", async () => {
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "user caption" },
            { type: "image", mimeType: "image/png", data: "dXNlci1pbWFnZQ==" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_inspect",
          toolName: "view_image",
          content: [
            { type: "text", text: "tool caption" },
            { type: "image", mimeType: "image/png", data: "dG9vbC1pbWFnZQ==" },
          ],
        },
      ],
    };
    await expectSuccessfulOllamaRequest(
      {
        model: { input: ["text", "image"] },
        context,
      },
      ({ body }) => {
        const messages = body.messages as Array<Record<string, unknown>>;
        expect(messages[0]?.images).toEqual(["dXNlci1pbWFnZQ=="]);
        expect(messages[1]?.images).toEqual(["dG9vbC1pbWFnZQ=="]);
        expect(messages[0]?.content).toContain("user caption");
        expect(messages[1]?.content).toContain("tool caption");
        expect(
          String(messages[0]?.content).includes("(image omitted: model does not support images)"),
        ).toBe(false);
        expect(
          String(messages[1]?.content).includes(
            "(tool image omitted: model does not support images)",
          ),
        ).toBe(false);
        expect(messages[1]?.tool_call_id).toBe("call_inspect");
      },
    );
    expect(JSON.stringify(context)).toContain("dXNlci1pbWFnZQ==");
    expect(JSON.stringify(context)).toContain("dG9vbC1pbWFnZQ==");
  });

  it.each([
    ["hosted", "https://ollama.com", {}],
    [
      "cloud provider proxy",
      "https://proxy.example.test",
      { provider: "ollama-cloud", id: "glm-5.2" },
    ],
    ["cloud model on local daemon", "http://ollama-host:11434", { id: "qwen3:32b-cloud" }],
  ] as const)("leaves %s history settings to the server", async (_name, baseUrl, model) => {
    await expectSuccessfulOllamaRequest({ baseUrl, model }, ({ body }) => {
      expect(body.truncate).toBeUndefined();
      expect(body.shift).toBeUndefined();
      expect(body.options).not.toHaveProperty("truncate");
      expect(body.options).not.toHaveProperty("shift");
    });
  });

  it("normalizes /v1 baseUrl and maps maxTokens + signal", async () => {
    const signal = new AbortController().signal;
    await expectSuccessfulOllamaRequest(
      {
        baseUrl: "http://ollama-host:11434/v1/",
        options: { maxTokens: 123, signal, timeoutMs: 123_456 },
      },
      ({ body, fetchMock, request }) => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(request.url).toBe("http://ollama-host:11434/api/chat");
        expect(request.auditContext).toBe("ollama-stream.chat");
        expect(request.signal).toBe(signal);
        expect(request.timeoutMs).toBe(123_456);
        expect(request.init?.signal).toBeUndefined();
        const options = requireRecord(body.options, "Ollama request options");
        expect(options.num_ctx).toBeUndefined();
        expect(options.num_predict).toBe(123);
        expect(body.truncate).toBe(false);
        expect(body.shift).toBe(false);
      },
    );
  });

  it("awaits asynchronous payload mutations before dispatching native Ollama requests", async () => {
    await withSuccessfulOllamaFetch(async (fetchMock) => {
      const { promise: payloadGate, resolve: releasePayload } = Promise.withResolvers<void>();
      const onPayload = vi.fn(async (payload: unknown) => {
        await payloadGate;
        requireRecord(payload, "Ollama request payload").model = "patched-model";
      });
      const stream = await createOllamaTestStream({ options: { onPayload } });

      await vi.waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
      expect(fetchMock).not.toHaveBeenCalled();
      releasePayload();
      const events = await collectStreamEvents(stream);

      expect(events.at(-1)?.type).toBe("done");
      expect(getGuardedFetchJsonBody(fetchMock).model).toBe("patched-model");
    });
  });

  it("dispatches asynchronous payload replacements for native Ollama requests", async () => {
    await expectSuccessfulOllamaRequest(
      {
        options: {
          onPayload: async () => {
            await Promise.resolve();
            return {
              model: "replacement-model",
              options: {
                stop: ["REPLACEMENT"],
              },
            };
          },
        },
      },
      ({ body }) => {
        expect(body.model).toBe("replacement-model");
        expect(requireRecord(body.options, "Ollama request options").stop).toEqual(["REPLACEMENT"]);
      },
    );
  });

  it.each([
    {
      name: "keeps provider-shaped text response formats off the native Ollama wire",
      responseFormat: { type: "text" },
    },
    {
      name: "omits native Ollama format for cloud model through a local daemon",
      id: "gemma4:cloud",
      responseFormat: { type: "object" },
    },
    {
      name: "omits native Ollama format for hosted Ollama Cloud",
      baseUrl: "https://ollama.com/v1",
      id: "gemma4",
      responseFormat: { type: "object" },
    },
    {
      name: "maps raw JSON Schema",
      responseFormat: { type: "object", properties: { reply: { type: "string" } } },
      expectedFormat: { type: "object", properties: { reply: { type: "string" } } },
    },
  ])("$name", async ({ baseUrl, id, responseFormat, expectedFormat }) => {
    await expectSuccessfulOllamaRequest(
      {
        baseUrl,
        ...(id ? { model: { id } } : {}),
        ...(responseFormat ? { options: { responseFormat } } : {}),
      },
      ({ body }) => expect(body.format).toEqual(expectedFormat),
    );
  });

  it("normalizes native tool schemas and keeps their serialization stable across discovery order", async () => {
    const tools = [
      {
        name: "search",
        description: "search",
        parameters: {
          properties: {
            query: { anyOf: [{ type: "string" }, { type: "null" }] },
            tags: { items: { type: "string" } },
          },
          required: ["query"],
        },
      },
      {
        name: "read",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const serialized: string[] = [];
    for (const orderedTools of [tools, tools.toReversed()]) {
      fetchWithSsrFGuardMock.mockClear();
      await expectSuccessfulOllamaRequest(
        {
          context: { messages: [{ role: "user", content: "hello" }], tools: orderedTools },
          options: {
            responseFormat: { type: "object", properties: { reply: { type: "string" } } },
          },
        },
        ({ body }) => {
          expect(body.tools).toEqual([
            { type: "function", function: tools[1] },
            {
              type: "function",
              function: {
                name: "search",
                description: "search",
                parameters: {
                  type: "object",
                  properties: {
                    query: { anyOf: [{ type: "string" }, { type: "null" }], type: "string" },
                    tags: { items: { type: "string" }, type: "array" },
                  },
                  required: ["query"],
                },
              },
            },
          ]);
          expect(body).not.toHaveProperty("format");
          serialized.push(JSON.stringify(body.tools));
        },
      );
    }
    expect(serialized[1]).toBe(serialized[0]);
    expect(tools.map((tool) => tool.name)).toEqual(["search", "read"]);
  });
  it.each([
    {
      name: "configured options",
      params: { num_ctx: 0 },
      options: { stop: [] },
      expected: {
        num_ctx: 16384,
        temperature: 0.8,
        top_p: 0.9,
        seed: 7,
        frequency_penalty: 0.5,
        presence_penalty: 0.75,
        stop: ["MODEL"],
      },
    },
    {
      name: "runtime zero overrides",
      params: { num_ctx: 32768 },
      options: {
        temperature: 0.7,
        maxTokens: 55,
        topP: 0,
        seed: 0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stop: ["REQUEST"],
      },
      expected: {
        num_ctx: 32768,
        temperature: 0.7,
        num_predict: 55,
        top_p: 0,
        seed: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        stop: ["REQUEST"],
      },
    },
    {
      name: "greedy normalization",
      params: { num_ctx: 32768 },
      options: { temperature: 0, topP: 0.6 },
      expected: { num_ctx: 32768, temperature: 0, top_p: 1 },
    },
  ])("maps native request options: $name", async ({ params, options, expected }) => {
    await expectSuccessfulOllamaRequest(
      {
        model: {
          contextWindow: 131072,
          contextTokens: 16384,
          params: {
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
            ...params,
          },
        },
        options,
      },
      ({ body }) => {
        expect(body.options).toMatchObject(expected);
        expect(requireRecord(body.options, "options").streaming).toBeUndefined();
        expect(body.think).toBe(false);
        expect(body.truncate).toBe(true);
        expect(body.shift).toBe(true);
      },
    );
  });

  it("uses the default loopback policy when baseUrl is empty", async () => {
    await expectSuccessfulOllamaRequest({ baseUrl: "" }, ({ request }) => {
      expect(request.url).toBe("http://127.0.0.1:11434/api/chat");
      const policy = requireRecord(request.policy, "ssrf policy");
      expect(policy.hostnameAllowlist).toEqual(["127.0.0.1"]);
      expect(policy.allowPrivateNetwork).toBe(true);
    });
  });

  it("redacts a configured header prefix split by the 8 KiB error cap", async () => {
    const configuredSecret = "stream-boundary-credential-secret";
    const retainedPrefix = configuredSecret.slice(0, -5);
    const safeMarker = "bounded stream diagnostic: ";
    const tracked = cancelTrackedTextResponse(
      `${safeMarker}${"x".repeat(8 * 1024 - safeMarker.length - retainedPrefix.length)}${configuredSecret} trailing text`,
      { status: 503, statusText: "Service Unavailable" },
    );
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: tracked.response,
      release: vi.fn(async () => undefined),
    });
    const timeline: string[] = [];
    const onResponse = vi.fn(() => {
      timeline.push("response");
    });
    const stream = await createOllamaTestStream({
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

  it("drops streamed reasoning chunks for non-reasoning models", async () => {
    const events = await collectMockedOllamaEvents(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      { model: { reasoning: false } },
    );
    const doneEvent = events.at(-1);
    if (!doneEvent || doneEvent.type !== "done") {
      throw new Error("Expected done event");
    }

    expect(doneEvent.message.content).toEqual([]);
    expect(doneEvent.message.usage.output).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
  });

  it("keeps streamed content after earlier reasoning chunks", async () => {
    const events = await collectMockedOllamaEvents([
      ndjson({ thinking: "internal" }),
      ndjson({ content: "final" }),
      ndjson({ content: " answer" }),
      ndjson({}, { done: true, prompt_eval_count: 1, eval_count: 2 }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: {
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "final answer" },
        ],
      },
    });
  });
});

describe("createConfiguredOllamaStreamFn", () => {
  it("streams model-specific remote endpoints without acquiring the provider service", async () => {
    await withSuccessfulOllamaFetch(async (fetchMock) => {
      const acquire = vi.fn(async () => ({ release: vi.fn() }));
      const events = await collectStreamEvents(
        await createOllamaTestStream({
          baseUrl: "",
          model: { provider: "ollama-gpu" },
          configured: {
            model: { baseUrl: "https://remote-ollama.example.test" },
            localService: { providerId: "ollama-gpu", acquire },
          },
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(acquire).toHaveBeenCalledTimes(0);
      expect(getGuardedFetchCall(fetchMock).url).toBe(
        "https://remote-ollama.example.test/api/chat",
      );
    });
  });
  it("acquires the provider service when model baseUrl is whitespace", async () => {
    await withSuccessfulOllamaFetch(async (fetchMock) => {
      const acquire = vi.fn(async () => ({ release: vi.fn() }));
      const events = await collectStreamEvents(
        await createOllamaTestStream({
          baseUrl: "",
          model: { provider: "ollama-gpu" },
          configured: {
            model: { baseUrl: "   " },
            localService: { providerId: "ollama-gpu", acquire },
          },
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(getGuardedFetchCall(fetchMock).url).toBe("http://127.0.0.1:11434/api/chat");
    });
  });
  it("uses provider-level baseUrl when model baseUrl is absent", async () => {
    await withSuccessfulOllamaFetch(async (fetchMock) => {
      await collectStreamEvents(
        await createOllamaTestStream({
          baseUrl: "",
          configured: {
            model: { headers: { Authorization: "Bearer proxy-token" } },
            providerBaseUrl: "http://provider-host:11434/v1",
          },
          options: { apiKey: "ollama-local" }, // pragma: allowlist secret
        }),
      );
      const request = getGuardedFetchCall(fetchMock);
      expect(request.url).toBe("http://provider-host:11434/api/chat");
      expect(request.init?.headers).toMatchObject({ Authorization: "Bearer proxy-token" });
    });
  });
  it("acquires the exact provider service after final payload and headers, before fetch", async () => {
    const signal = new AbortController().signal;
    const leaseRelease = vi.fn();
    const payloadStarted = Promise.withResolvers<void>();
    const finishPayload = Promise.withResolvers<void>();
    let payloadReady = false;
    const preparationAtAcquisition: boolean[] = [];
    const acquire = vi.fn(async () => {
      preparationAtAcquisition.push(payloadReady);
      return { release: leaseRelease };
    });
    const guardRelease = mockResponse(
      ndjson({ content: "ok" }) + "\n" + ndjson({}, { done: true }),
    );

    const stream = await createManagedOllamaTestStream({
      providerId: "ollama-gpu",
      defaultHeaders: { "X-Provider": "provider", Authorization: "Bearer proxy-token" },
      options: {
        apiKey: "real-token", // pragma: allowlist secret
        headers: { "X-Request": "request" },
        onPayload: async (payload) => {
          payloadStarted.resolve();
          await finishPayload.promise;
          payloadReady = true;
          return { ...requireRecord(payload, "payload"), model: "patched" };
        },
        signal,
      },
      acquire,
    });
    const eventsPromise = collectStreamEvents(stream);
    try {
      await payloadStarted.promise;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      finishPayload.resolve();
      await eventsPromise;
    }

    expect(preparationAtAcquisition).toEqual([true]);
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
    expect(getGuardedFetchJsonBody(fetchWithSsrFGuardMock).model).toBe("patched");
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(fetchWithSsrFGuardMock.mock.invocationCallOrder[0], "fetch call order"),
    );
    expect(guardRelease).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
    expect(guardRelease.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(leaseRelease.mock.invocationCallOrder[0], "lease release call order"),
    );
  });

  it("times out pending local-service acquisition before fetch", async () => {
    vi.useFakeTimers();
    try {
      let acquisitionSignal: AbortSignal | undefined;
      const acquire = vi.fn((_request, signal) => {
        const timeoutSignal = expectDefined(signal, "acquisition timeout signal");
        acquisitionSignal = timeoutSignal;
        return rejectWhenAborted(timeoutSignal);
      });
      const eventsPromise = collectStreamEvents(
        await createManagedOllamaTestStream({
          model: { requestTimeoutMs: 25 },
          acquire,
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      const events = await eventsPromise;

      expect(acquisitionSignal?.reason).toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      expect(events).toMatchObject([
        { type: "error", reason: "error", error: { errorMessage: "request timed out" } },
      ]);
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps caller aborts classified as aborted during acquisition", async () => {
    const caller = new AbortController();
    let acquisitionSignal: AbortSignal | undefined;
    const acquire = vi.fn((_request, signal) => {
      const combinedSignal = expectDefined(signal, "combined acquisition signal");
      acquisitionSignal = combinedSignal;
      return rejectWhenAborted(combinedSignal);
    });
    const eventsPromise = collectStreamEvents(
      await createManagedOllamaTestStream({
        model: { requestTimeoutMs: 5_000 },
        options: { signal: caller.signal },
        acquire,
      }),
    );
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    const reason = new Error("caller stopped");
    caller.abort(reason);
    const events = await eventsPromise;

    expect(acquisitionSignal?.reason).toBe(reason);
    expect(events).toMatchObject([{ type: "error", reason: "aborted" }]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("cleans the acquisition timer before a long progressing stream", async () => {
    vi.useFakeTimers();
    try {
      const source = createControlledNdjsonFetch();
      fetchWithSsrFGuardMock.mockImplementation(source.fetchImpl);
      let acquisitionSignal: AbortSignal | undefined;
      const acquire = vi.fn(async (_request, signal) => {
        acquisitionSignal = expectDefined(signal, "acquisition timeout signal");
        return { release: vi.fn() };
      });
      const eventsPromise = collectStreamEvents(
        await createManagedOllamaTestStream({
          model: { requestTimeoutMs: 25 },
          acquire,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(getGuardedFetchCall(fetchWithSsrFGuardMock)).toMatchObject({ timeoutMs: 25 });
      expect(getGuardedFetchCall(fetchWithSsrFGuardMock).signal).toBeUndefined();
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
    } finally {
      vi.useRealTimers();
    }
  });
  it("holds the local-service lease through incomplete NDJSON handling", async () => {
    const source = createControlledNdjsonFetch();
    fetchWithSsrFGuardMock.mockImplementation(source.fetchImpl);
    const leaseRelease = vi.fn();
    const acquire = vi.fn(async () => ({ release: leaseRelease }));
    const stream = await createManagedOllamaTestStream({ acquire });
    const iterator = stream[Symbol.asyncIterator]();
    source.pushLine(ndjson({ content: "partial" }));
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "start" } });
    expect(leaseRelease).not.toHaveBeenCalled();
    source.close();
    const events = await collectStreamEvents(stream);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: OLLAMA_INCOMPLETE_STREAM_ERROR },
    });
    expect(source.release).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
  });
  it("releases the service exactly once after an empty body", async () => {
    const leaseRelease = vi.fn();
    const acquire = vi.fn(async () => ({ release: leaseRelease }));
    const guardRelease = mockResponse(null);
    const events = await collectStreamEvents(await createManagedOllamaTestStream({ acquire }));
    expect(events).toMatchObject([{ type: "error" }]);
    expect(acquire).toHaveBeenCalledOnce();
    expect(guardRelease).toHaveBeenCalledOnce();
    expect(leaseRelease).toHaveBeenCalledOnce();
  });

  it("releases the service exactly once when guarded fetch rejects", async () => {
    const leaseRelease = vi.fn();
    const acquire = vi.fn(async () => ({ release: leaseRelease }));
    fetchWithSsrFGuardMock.mockRejectedValue(
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
    );

    const events = await collectStreamEvents(await createManagedOllamaTestStream({ acquire }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: "connect failed", errorCode: "ECONNREFUSED" },
    });
    expect(leaseRelease).toHaveBeenCalledOnce();
  });

  it("does not acquire or fetch when payload preparation rejects", async () => {
    const acquire = vi.fn();

    const events = await collectStreamEvents(
      await createManagedOllamaTestStream({
        options: {
          onPayload: () => {
            throw new Error("payload rejected");
          },
        },
        acquire,
      }),
    );

    expect(events).toMatchObject([{ type: "error", reason: "error" }]);
    expect(acquire).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
