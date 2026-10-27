/// <reference lib="esnext.array" />

import type { IncomingHttpHeaders } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { requestBodyText, withServer } from "openclaw/plugin-sdk/test-env";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { createModel } from "../model.test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildOllamaModelDefinition } from "./provider-models.js";
import {
  buildAssistantMessage,
  createOllamaStreamFn,
  isOllamaCompatProvider,
} from "./stream-api.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
} from "./stream.runtime.js";

function makeOllamaResponse({
  done_reason,
  ...message
}: Partial<Omit<Parameters<typeof buildAssistantMessage>[0]["message"], "role">> & {
  done_reason?: string;
}) {
  return chunk(
    { content: "", ...message },
    { done: true, prompt_eval_count: 100, eval_count: 50, done_reason },
  );
}

function chunk(
  message: Omit<Parameters<typeof buildAssistantMessage>[0]["message"], "role">,
  metadata: Partial<Parameters<typeof buildAssistantMessage>[0]> = {},
) {
  return {
    model: "qwen3.5",
    created_at: "2026-01-01T00:00:00Z",
    message: { role: "assistant" as const, ...message },
    done: false,
    ...metadata,
  };
}

function terminalChunk(metadata: Partial<Parameters<typeof buildAssistantMessage>[0]> = {}) {
  return chunk({ content: "" }, { done: true, done_reason: "stop", ...metadata });
}

const readEvents = async (stream: ReturnType<ReturnType<typeof createOllamaStreamFn>>) =>
  Array.fromAsync(await stream);

const realContext = { messages: [{ role: "user" as const, content: "test", timestamp: 0 }] };
const requestEvents = (
  streamFn: ReturnType<typeof createOllamaStreamFn>,
  options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
) => readEvents(streamFn(STREAM_MODEL, realContext, options));

async function withNativeServer(
  handler: Parameters<typeof withServer>[0],
  run: (streamFn: ReturnType<typeof createOllamaStreamFn>) => Promise<void>,
  headers?: Record<string, string>,
) {
  const { fetchWithSsrFGuard } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/ssrf-runtime")
  >("openclaw/plugin-sdk/ssrf-runtime");
  fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);
  await withServer(handler, (baseUrl) => run(createOllamaStreamFn(baseUrl, headers)));
}

const denseChunks = () => [
  ...Array.from({ length: 65 }, () => chunk({ content: "x" })),
  makeOllamaResponse({}),
];

const MODEL_INFO = { api: "ollama", provider: "ollama", id: "qwen3.5" };
const STREAM_MODEL = {
  ...createModel("qwen3.5", "qwen3.5", { reasoning: true, contextWindow: 65536 }),
  api: "ollama",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
} satisfies ProviderRuntimeModel;

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

function makeNdjsonBody(chunks: Array<Record<string, unknown>>) {
  return chunks.map((record) => JSON.stringify(record) + "\n").join("");
}

function mockResponse(
  chunks: Array<Record<string, unknown>>,
  extras: Partial<Awaited<ReturnType<typeof fetchWithSsrFGuard>>> = {},
) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(makeNdjsonBody(chunks)),
    release: async () => {},
    ...extras,
  });
}

const sentBody = () =>
  JSON.parse(requestBodyText(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init?.body));
const doneEvent = (events: AssistantMessageEvent[]) =>
  events.find((event) => event.type === "done");

function expectEventTypes(events: AssistantMessageEvent[], types: string) {
  expect(events.map((event) => event.type)).toEqual(types.split(" "));
}

async function successfulRequest(
  model: ProviderRuntimeModel,
  options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
  context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = realContext,
  streamFn = createOllamaStreamFn(model.baseUrl),
) {
  mockResponse([makeOllamaResponse({ content: "ok", done_reason: "stop" })]);
  expect((await (await streamFn(model, context, options)).result()).stopReason).toBe("stop");
  return sentBody();
}

function startMockStream(
  chunks: Array<Record<string, unknown>>,
  options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
  context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = realContext,
  model: ProviderRuntimeModel = STREAM_MODEL,
) {
  mockResponse(chunks);
  return createOllamaStreamFn(model.baseUrl)(model, context, options);
}

const streamOllamaEvents = (...args: Parameters<typeof startMockStream>) =>
  readEvents(startMockStream(...args));

it.each([
  ["http://localhost:11434", true],
  ["http://127.0.0.1:11434", true],
  ["http://127.0.0.2:11434", true],
  ["http://[::1]:11434", true],
  ["http://[::ffff:127.0.0.2]:11434", true],
  ["http://10.0.0.1:11434", false],
  ["http://127.0.0.1.evil.com:11434", false],
] as const)("classifies %s as Ollama-compatible=%s", (baseUrl, expected) => {
  expect(isOllamaCompatProvider({ provider: "custom", baseUrl })).toBe(expected);
});

describe("buildAssistantMessage", () => {
  it.each<[string, ReturnType<typeof buildAssistantMessage>["content"]]>([
    [
      "From thinking field",
      [
        { type: "thinking", thinking: "From thinking field" },
        { type: "text", text: "Answer" },
      ],
    ],
    ["", [{ type: "text", text: "Answer" }]],
  ])("prefers thinking=%s over the reasoning alias", (thinking, content) => {
    const response = makeOllamaResponse({
      thinking,
      reasoning: "From reasoning field",
      content: "Answer",
    });
    expect(buildAssistantMessage(response, MODEL_INFO).content).toEqual(content);
  });

  it("keeps a length stop authoritative over complete-looking tool calls", () => {
    const response = makeOllamaResponse({
      done_reason: "length",
      tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }],
    });
    expect(buildAssistantMessage(response, MODEL_INFO).stopReason).toBe("length");
  });
});

describe("createOllamaStreamFn thinking events", () => {
  it.each([
    [
      { prompt_eval_duration: 1_250_000, eval_duration: 2_500_000, load_duration: 900_000_000 },
      3.75,
    ],
    [{ prompt_eval_duration: 1 }, undefined],
    [{ eval_duration: 1 }, undefined],
    [{ prompt_eval_duration: -1, eval_duration: 1 }, undefined],
    [{ prompt_eval_duration: "1", eval_duration: 1 }, undefined],
    [{ prompt_eval_duration: Number.MAX_VALUE, eval_duration: Number.MAX_VALUE }, undefined],
  ] as const)("uses only valid final processing timing: %j", async (timing, processingMs) => {
    const events = await streamOllamaEvents([
      chunk({ content: "ok" }, { prompt_eval_duration: 1_000_000, eval_duration: 2_000_000 }),
      { ...makeOllamaResponse({}), ...timing },
    ]);
    const terminal = doneEvent(events);
    expect(terminal).toMatchObject({ message: { content: [{ type: "text", text: "ok" }] } });
    if (processingMs === undefined) {
      expect(terminal).not.toHaveProperty("message.diagnostics");
    } else {
      expect(terminal?.message.diagnostics).toEqual([
        { type: "provider_timing", timestamp: expect.any(Number), details: { processingMs } },
      ]);
    }
  });

  it.each([undefined, "Private reasoning"])(
    "keeps native tool narration unsigned with reasoning %s",
    async (thinking) => {
      const path = "README.md";
      const events = await streamOllamaEvents(
        [
          chunk({ content: "Let me ", thinking }),
          chunk({ content: "read README.md." }),
          makeOllamaResponse({
            tool_calls: [{ function: { name: "read", arguments: { path } } }],
          }),
        ],
        {},
        {
          messages: [{ role: "user", content: "Read README.md." }],
          tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
        } as never,
      );
      const done = doneEvent(events);
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("Let me read README.md.");
      expect(
        events.find((event) => event.type === "toolcall_delta")?.partial.content,
      ).toContainEqual(expect.objectContaining({ partialJson: JSON.stringify({ path }) }));
      expect(done?.message.content).toEqual([
        ...(thinking ? [{ type: "thinking", thinking: "Private reasoning" }] : []),
        { type: "text", text: "Let me read README.md." },
        { type: "toolCall", id: expect.any(String), name: "read", arguments: { path } },
      ]);
    },
  );

  it.each(["stop", "length"])(
    "keeps text before reasoning deliverable at a %s terminal",
    async (done_reason) => {
      const events = await streamOllamaEvents([
        chunk({ content: "Visible answer" }),
        makeOllamaResponse({ thinking: "Late reasoning", done_reason }),
      ]);
      const done = doneEvent(events);
      expect(done).toMatchObject({
        reason: done_reason,
        message: {
          stopReason: done_reason,
          content: [
            { type: "thinking", thinking: "Late reasoning" },
            { type: "text", text: "Visible answer" },
          ],
        },
      });
      expect(
        done?.message.content.find((block) => block.type === "text")?.textSignature,
      ).toBeUndefined();
    },
  );

  it("emits thinking_start, thinking_delta, and thinking_end events for thinking content", async () => {
    const thinkingChunks = [
      chunk({ content: "", thinking: "Step 1" }),
      chunk({ content: "", thinking: " and step 2" }),
      chunk({ content: "The answer", thinking: "" }),
      terminalChunk({ prompt_eval_count: 10, eval_count: 5 }),
    ];

    const events = await streamOllamaEvents(thinkingChunks);
    expectEventTypes(
      events,
      "start thinking_start thinking_delta thinking_delta thinking_end text_start text_delta text_end done",
    );
    expect(events.filter((e) => e.type === "thinking_delta").map((e) => e.delta)).toEqual([
      "Step 1",
      " and step 2",
    ]);

    expect(events.find((e) => e.type === "thinking_start")).toMatchObject({ contentIndex: 0 });
    expect(events.find((e) => e.type === "text_start")).toMatchObject({ contentIndex: 1 });
    expect(doneEvent(events)?.message.content).toEqual([
      { type: "thinking", thinking: "Step 1 and step 2" },
      { type: "text", text: "The answer" },
    ]);
  });

  it.each([
    {
      format: "bracketed",
      name: "search_docs",
      raw: '[search_docs]\n{"query":"x"}\n[END_TOOL_REQUEST]',
      args: { query: "x" },
      parameters: { type: "object", properties: {} },
    },
    {
      format: "Harmony",
      name: "read",
      raw: 'commentary to=read code {"path":"x"}',
      args: { path: "x" },
      parameters: { type: "object" },
    },
  ])(
    "promotes standalone $format text to a structured tool call",
    async ({ name, raw, args, parameters }) => {
      const events = await streamOllamaEvents(
        [chunk({ content: raw }), terminalChunk({ prompt_eval_count: 10, eval_count: 5 })],
        {},
        {
          messages: [{ role: "user", content: "test", timestamp: 0 }],
          tools: [{ name, description: name, parameters }],
        },
      );
      expectEventTypes(events, "start toolcall_start toolcall_delta toolcall_end done");
      expect(doneEvent(events)).toMatchObject({
        reason: "toolUse",
        message: { stopReason: "toolUse", content: [{ type: "toolCall", name, arguments: args }] },
      });
    },
  );

  it("preserves a fenced Ollama text tool call as visible text", async () => {
    const text = [
      "```powershell",
      'exec(command="echo hello", title="Echo command", workdir="C:\\workspace")',
      "```",
    ].join("\n");
    const events = await streamOllamaEvents(
      [makeOllamaResponse({ content: text })],
      {},
      {
        messages: [{ role: "user", content: "Use exec to run echo hello", timestamp: 0 }],
        tools: [
          {
            name: "exec",
            description: "Run a command",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    );

    expectEventTypes(events, "start text_start text_delta text_end done");
    expect(doneEvent(events)).toMatchObject({
      reason: "stop",
      message: { stopReason: "stop", content: [{ type: "text", text }] },
    });
  });

  it("refreshes the guarded-fetch idle timeout for each streamed Ollama response", async () => {
    const chunks = [
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      makeOllamaResponse({ content: "" }),
    ];
    const refreshTimeout = vi.fn();
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);
    mockResponse(chunks, { refreshTimeout });
    try {
      const events = await requestEvents(createOllamaStreamFn(STREAM_MODEL.baseUrl), {
        signal: controller.signal,
      });
      expect(doneEvent(events)).toBeDefined();
    } finally {
      unsubscribe();
    }

    expect(refreshTimeout).toHaveBeenCalledTimes(chunks.length);
    expect(onActivity).toHaveBeenCalledTimes(chunks.length);
  });

  it("omits a deleted model header from a real Ollama request", async () => {
    let received: string | string[] | undefined = "request not received";
    await withNativeServer(
      (request, response) => {
        received = request.headers["x-proxy-auth"];
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.end(`${JSON.stringify(makeOllamaResponse({ content: "ok" }))}\n`);
      },
      async (streamFn) => {
        const events = await requestEvents(streamFn, { headers: { "x-proxy-auth": null } });
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
      { "X-Proxy-Auth": "removed" },
    );
    expect(received).toBeUndefined();
  });

  it("redacts reflected credentials from a real non-2xx Ollama response", async () => {
    const configuredSecret = "stream-transport-configured-secret";
    const bearerCredential = "stream-transport-bearer-secret";
    let receivedHeaders: IncomingHttpHeaders | undefined;
    await withNativeServer(
      (request, response) => {
        receivedHeaders = request.headers;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "rate limit exceeded",
            configuredEcho: configuredSecret,
            bearerEcho: bearerCredential,
          }),
        );
      },
      async (streamFn) => {
        const events = await requestEvents(streamFn, { apiKey: bearerCredential });

        const errorEvent = events.find((event) => event.type === "error");
        expect(receivedHeaders?.["x-proxy-auth"]).toBe(configuredSecret);
        expect(receivedHeaders?.authorization).toBe(`Bearer ${bearerCredential}`);
        expect(errorEvent?.error?.errorMessage).toMatch(/^429\b/);
        expect(errorEvent?.error?.errorMessage).toContain("rate limit exceeded");
        expect(errorEvent?.error?.errorMessage).not.toContain(configuredSecret);
        expect(errorEvent?.error?.errorMessage).not.toContain(bearerCredential);
      },
      { "X-Proxy-Auth": configuredSecret },
    );
  });

  it("rejects incomplete UTF-8 after a real terminal Ollama response", async () => {
    let corrupted = true;
    await withNativeServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        const valid = Buffer.from(`${JSON.stringify(makeOllamaResponse({ content: "ok" }))}\n`);
        response.end(corrupted ? Buffer.concat([valid, Buffer.from([0xc3])]) : valid);
      },
      async (streamFn) => {
        const readEventTypes = async () =>
          (await requestEvents(streamFn)).map((event) => event.type);

        expect(await readEventTypes()).toContain("error");
        corrupted = false;
        expect(await readEventTypes()).toContain("done");
      },
    );
  });

  it("keeps a real slow native Ollama response alive while NDJSON chunks advance", async () => {
    const chunkCount = 24;
    const chunkDelayMs = 250;
    const requestTimeoutMs = 5_000;
    await withNativeServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });

        let chunkIndex = 0;
        let nextChunk: ReturnType<typeof setTimeout> | undefined;
        const sendChunk = () => {
          if (chunkIndex === chunkCount) {
            response.end(`${JSON.stringify(makeOllamaResponse({ content: "" }))}\n`);
            return;
          }
          response.write(`${JSON.stringify(chunk({ content: String(chunkIndex) }))}\n`);
          chunkIndex += 1;
          nextChunk = setTimeout(sendChunk, chunkDelayMs);
        };

        response.once("close", () => {
          if (nextChunk) {
            clearTimeout(nextChunk);
          }
        });
        sendChunk();
      },
      async (streamFn) => {
        const events = await requestEvents(streamFn, { requestTimeoutMs } as never);

        expect(events.some((event) => event.type === "error")).toBe(false);
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
    );
  }, 20_000);

  it("still times out a real native Ollama stream that stops making progress", async () => {
    await withNativeServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify(chunk({ content: "partial" }))}\n`);
      },
      async (streamFn) => {
        const events = await requestEvents(streamFn, { requestTimeoutMs: 120 } as never);

        expect(events.some((event) => event.type === "error")).toBe(true);
        expect(events.some((event) => event.type === "done")).toBe(false);
      },
    );
  });

  it("reports caller aborts during dense native stream processing as aborted", async () => {
    const controller = new AbortController();
    const stream = startMockStream(denseChunks(), { signal: controller.signal });

    setTimeout(() => {
      controller.abort();
    }, 0);

    const events = await readEvents(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { stopReason: "aborted" },
    });
  });

  it.each([
    [undefined, undefined, 12, 6],
    [77, 19, 77, 19, 0, 96],
    [0, 0, 0, 0, 0, 0],
    [undefined, 19, 12, 19],
    [77, undefined, 77, 6],
    [-1, 19, 12, 19],
    [77, -1, 77, 6],
    [100, 50, 20, 50, 80, 150],
  ])(
    "resolves provider counters %s/%s independently of CJK estimates and cache provenance",
    async (
      promptCount,
      completionCount,
      expectedInput,
      expectedOutput,
      cacheRead = 0,
      totalTokens?: number,
    ) => {
      const events = await streamOllamaEvents(
        [
          chunk({ content: "你好世界测试" }),
          terminalChunk({
            prompt_eval_count: promptCount,
            eval_count: completionCount,
            ...(cacheRead ? { prompt_eval_cached_count: cacheRead } : {}),
          }),
        ],
        {},
        { messages: [{ role: "user", content: "这是一个测试用的句子呢", timestamp: 0 }] },
      );

      const usage = doneEvent(events)?.message.usage;
      const contextUsage =
        totalTokens === undefined
          ? undefined
          : { state: "available", promptTokens: promptCount, totalTokens };
      expect(usage).toMatchObject({
        input: expectedInput,
        output: expectedOutput,
        cacheRead,
        cacheWrite: 0,
        cacheTelemetry: { state: cacheRead ? "available" : "unavailable" },
        usageReport: { state: contextUsage ? "available" : "unavailable" },
      });
      expect(usage?.contextUsage).toEqual(contextUsage);
    },
  );

  it("keeps the existing fallback estimate for ASCII-only usage", async () => {
    const events = await streamOllamaEvents(
      [chunk({ content: "Hello world" }), terminalChunk()],
      {},
      {
        messages: [
          { role: "user", content: "The quick brown fox jumps over the lazy dog", timestamp: 0 },
        ],
      },
    );

    expect(doneEvent(events)?.message.usage).toMatchObject({ input: 11, output: 3 });
  });
});

const local = { provider: "ollama", baseUrl: "http://127.0.0.1:11434" };
const hiddenReasoning = {
  ...local,
  id: "mandatory-thinking",
  params: { think: false },
  reasoning: false,
};
type ThinkLevel = "off" | "high" | "max";
type ThinkValue = string | boolean | undefined;

describe("native Ollama direct completion reasoning", () => {
  it.each([
    ["explicit off", {}, "off", false],
    ["omitted reasoning", {}, undefined, undefined],
    ["configured think", { params: { think: true } }, "off", true],
    ["configured thinking alias", { params: { thinking: "medium" } }, "off", "medium"],
    ["think over thinking", { params: { think: false, thinking: "medium" } }, "off", false],
    ["non-thinking model", { reasoning: false }, "off", false],
    [
      "unsupported configured thinking",
      { reasoning: false, params: { think: true } },
      "off",
      false,
    ],
    ["Cloud model thinking floor", { id: "glm-5.3:cloud" }, "off", "low"],
  ] as const)("serializes %s", async (_name, overrides, reasoning, expectedThink) => {
    const request = await successfulRequest(
      { ...STREAM_MODEL, id: "qwen3:4b", ...overrides },
      { maxTokens: 24, ...(reasoning === undefined ? {} : { reasoning }) },
    );
    expect(request.think).toBe(expectedThink);
    expect(request.options).toMatchObject({ num_predict: 24 });
    expect(request.options).not.toHaveProperty("think");
  });

  it.each([
    { field: "thinking", answer: "OK", reasoning: false, finish: "stop", terminal: "done" },
    { field: "reasoning", answer: "", reasoning: false, finish: "stop", terminal: "error" },
    { field: "thinking", answer: "", reasoning: false, finish: "length", terminal: "error" },
    { field: "reasoning", answer: "OK", reasoning: true, finish: "stop", terminal: "done" },
  ])("keeps $field private with reasoning=$reasoning and finish=$finish", async (testCase) => {
    const hidden = "synthetic private thought";
    const stream = await startMockStream(
      [
        chunk({ content: "", [testCase.field]: hidden }),
        chunk(
          { content: testCase.answer },
          { done: true, done_reason: testCase.finish, prompt_eval_count: 3, eval_count: 7 },
        ),
      ],
      {},
      realContext,
      { ...STREAM_MODEL, id: "qwen3:4b", reasoning: testCase.reasoning },
    );
    const events = await readEvents(stream);
    const result = await stream.result();
    expect(events.at(-1)?.type).toBe(testCase.terminal);
    expect(result.content.filter((block) => block.type === "text")).toEqual(
      testCase.answer ? [{ type: "text", text: testCase.answer }] : [],
    );
    expect(result.usage.output).toBe(7);
    if (testCase.reasoning) {
      expect(result.diagnostics).toBeUndefined();
      expect(result.content).toContainEqual({ type: "thinking", thinking: hidden });
    } else {
      expect(JSON.stringify(result)).not.toContain(hidden);
      expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
      expect(result.diagnostics).toEqual([
        { type: "reasoning_suppressed", timestamp: expect.any(Number) },
      ]);
      if (testCase.terminal === "error") {
        expect(result.errorMessage).toContain("reasoning: true");
        expect(result.errorMessage).toContain("ollama/qwen3:4b");
      }
    }
  });
});

async function sentThinking(
  overrides: Partial<ProviderRuntimeModel>,
  level?: ThinkLevel,
  providerBaseUrl?: string,
) {
  const model: ProviderRuntimeModel = {
    ...STREAM_MODEL,
    id: "glm-5.3",
    provider: "ollama-cloud",
    baseUrl: "https://ollama.com",
    contextWindow: 131072,
    ...overrides,
  };
  const native = createConfiguredOllamaStreamFn({ model, providerBaseUrl });
  const streamFn =
    level === undefined
      ? native
      : expectDefined(
          createConfiguredOllamaCompatStreamWrapper({
            provider: model.provider,
            modelId: model.id,
            model,
            thinkingLevel: level,
            config: providerBaseUrl
              ? createModelProviderConfig({
                  ollama: { baseUrl: providerBaseUrl, api: "ollama", models: [] },
                })
              : undefined,
            streamFn: native,
          }),
          "wrapped stream",
        );
  const body = await successfulRequest(model, {}, realContext, streamFn);
  return { url: fetchWithSsrFGuardMock.mock.calls[0]?.[0].url, think: body.think };
}

describe("Ollama mandatory thinking", () => {
  it.each<[Partial<ProviderRuntimeModel>, ThinkLevel, ThinkValue]>([
    [{}, "off", "low"],
    [{ id: "glm-5.3-flash" }, "off", "low"],
    [{ ...local, id: "glm-5.3:cloud" }, "off", "low"],
    [{ params: { think: false } }, "off", "low"],
    [{ params: { think: false }, reasoning: false }, "high", "low"],
    [{ ...hiddenReasoning, thinkingLevelMap: { off: "true", high: "true" } }, "high", true],
    [{}, "high", "high"],
    [{ id: "glm-5.2" }, "off", false],
    [{ ...local, id: "glm-5.3:q4_K_M" }, "off", false],
  ])("agent turn %j at %s sends %s", async (model, level, think) => {
    expect((await sentThinking(model, level)).think).toBe(think);
  });

  it.each<[Partial<ProviderRuntimeModel>, ThinkValue]>([
    [{ params: { think: false } }, "low"],
    [{ ...hiddenReasoning, thinkingLevelMap: { off: "true" } }, true],
    [{ id: "glm-5.2", params: { think: false } }, false],
    [{}, undefined],
  ])("direct completion %j sends %s", async (model, think) => {
    expect((await sentThinking(model)).think).toBe(think);
  });
});

describe.each(["runtime", "configured"] as const)("%s maximum thinking", (source) => {
  const cloud = "https://ollama.com";
  it.each<[string, string, string?, string?]>([
    [cloud, "max"],
    [cloud + "/v1/", "max"],
    [local.baseUrl, "max", cloud],
    [cloud, "high", local.baseUrl],
    [local.baseUrl, "high"],
    [cloud, "max", undefined, "glm-5.2:cloud"],
    [local.baseUrl, "high", undefined, "glm-5.2:cloud"],
    [cloud, "high", undefined, "qwen3:32b"],
    ["https://ollama.com.example.test", "high"],
  ])(
    "%s sends %s (provider %s; model %s)",
    async (baseUrl, think, providerBaseUrl, id = "glm-5.2") => {
      expect(
        await sentThinking(
          {
            id,
            provider: "ollama",
            baseUrl,
            ...(source === "configured" ? { params: { thinking: "max" } } : {}),
          },
          source === "runtime" ? "max" : "off",
          providerBaseUrl,
        ),
      ).toEqual({
        think,
        url: (providerBaseUrl ?? baseUrl.replace(/\/v1\/?$/, "")) + "/api/chat",
      });
    },
  );
});

const outputModel: ProviderRuntimeModel = {
  ...STREAM_MODEL,
  id: "local-model",
  provider: "custom-ollama",
  reasoning: false,
  contextWindow: 200_000,
};

describe("native Ollama output guards", () => {
  it.each<[string, Partial<ProviderRuntimeModel>, number | undefined, number]>([
    ["resolved model cap", { maxTokens: 3072 }, undefined, 3072],
    ["authored native cap", { params: { num_predict: 123 } }, undefined, 123],
    ["authored unlimited sentinel", { params: { num_predict: -1 } }, undefined, -1],
    ["runtime over authored defaults", { maxTokens: 3072, params: { num_predict: 123 } }, 55, 55],
    ["runtime above model metadata", { maxTokens: 3072 }, 4096, 4096],
  ])("sends %s as num_predict", async (_name, overrides, maxTokens, expected) => {
    const body = await successfulRequest({ ...outputModel, ...overrides }, { maxTokens });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(body).toMatchObject({ options: { num_predict: expected } });
  });

  it.each(["minimax-m3", "kimi-k3"])(
    "sends the local default for a bare %s catalog collision",
    async (id) => {
      const definition = buildOllamaModelDefinition(id);
      const body = await successfulRequest(
        { ...outputModel, id, maxTokens: definition.maxTokens },
        {},
      );
      expect(body).toMatchObject({ options: { num_predict: 8192 } });
    },
  );

  it("replays preserved blocks and the repetition marker through the native request", async () => {
    const body = await successfulRequest(
      outputModel,
      {},
      {
        messages: [
          { role: "user", content: "start", timestamp: 1 },
          makeAgentAssistantMessage({
            api: outputModel.api,
            provider: outputModel.provider,
            model: outputModel.id,
            content: [
              { type: "text", text: "Earlier answer stays intact." },
              { type: "text", text: "[Repetitive output stopped]" },
            ],
            stopReason: "error",
            errorCode: "openclaw_repetitive_output",
            timestamp: 2,
          }),
          { role: "user", content: "next", timestamp: 3 },
        ],
      },
    );
    expect(body.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: "Earlier answer stays intact.[Repetitive output stopped]" },
      { role: "user", content: "next" },
    ]);
  });
});

describe("native Ollama held request status", () => {
  const notify = vi.fn();
  const start = (options: { signal?: AbortSignal } = {}, id = "qwen3:4b") =>
    createOllamaStreamFn(STREAM_MODEL.baseUrl)(
      { ...STREAM_MODEL, id, contextWindow: 32768 },
      { messages: [] },
      { onProviderWait: notify, ...options },
    );
  beforeEach(() => {
    vi.useFakeTimers();
    notify.mockReset();
  });

  it("uses honest fallback wording after HTTP acceptance and clears on the first record", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "http://localhost:11434/api/chat",
      response: new Response(body),
      release: async () => {},
    });
    const stream = await start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual([["response"]]);
    const enqueue = (content: string, done: boolean) =>
      controller?.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({ message: { role: "assistant", content }, done })}\n`,
        ),
      );
    enqueue("ok", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    enqueue("", true);
    controller?.close();
    expect((await stream.result()).stopReason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "failure", "cloud"] as const)("settles a held %s request", async (ending) => {
    const cloud = ending === "cloud";
    const controller = new AbortController();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fetchWithSsrFGuard>>>();
    fetchWithSsrFGuardMock.mockReturnValue(pending.promise);
    const stream = await start({ signal: controller.signal }, cloud ? "qwen3:cloud" : "qwen3:4b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notify.mock.calls).toEqual(cloud ? [] : [["response"]]);
    if (ending === "cancel") {
      controller.abort();
      expect(notify.mock.calls).toEqual([["response"], [null]]);
    }
    pending.reject(new Error("request stopped"));
    expect((await stream.result()).stopReason).toBe(ending === "cancel" ? "aborted" : "error");
    expect(notify.mock.calls).toEqual(cloud ? [] : [["response"], [null]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
