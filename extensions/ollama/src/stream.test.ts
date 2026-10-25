import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { requestBodyText, withServer } from "openclaw/plugin-sdk/test-env";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}: {
  content?: string;
  thinking?: string;
  reasoning?: string;
  done_reason?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}) {
  return chunk(
    { content: "", ...message },
    {
      done: true,
      prompt_eval_count: 100,
      eval_count: 50,
      ...(done_reason ? { done_reason } : {}),
    },
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

async function readEvents(stream: ReturnType<ReturnType<typeof createOllamaStreamFn>>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of await stream) {
    events.push(event);
  }
  return events;
}

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

function denseChunks() {
  return [
    ...Array.from({ length: 65 }, (_value, index) =>
      chunk(
        { content: "x" },
        {
          created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        },
      ),
    ),
    makeOllamaResponse({}),
  ];
}

const USER = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
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

function startMockStream(
  chunks: Array<Record<string, unknown>>,
  options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
  context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = {
    messages: [{ role: "user", content: "test", timestamp: 0 }],
  },
) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(makeNdjsonBody(chunks), { status: 200 }),
    release: vi.fn(async () => undefined),
  });
  return createOllamaStreamFn("http://localhost:11434")(STREAM_MODEL, context, options);
}

async function streamOllamaEvents(
  chunks: Array<Record<string, unknown>>,
  options: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] = {},
  context: Parameters<ReturnType<typeof createOllamaStreamFn>>[1] = {
    messages: [{ role: "user", content: "test" }],
  } as never,
) {
  return readEvents(startMockStream(chunks, options, context));
}

describe("isOllamaCompatProvider", () => {
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
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.stopReason).toBe("length");
  });

  it("anchors context usage on measured prompt and output including cached tokens", () => {
    const response = {
      ...makeOllamaResponse({ content: "ok" }),
      prompt_eval_cached_count: 80,
    };
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.usage).toMatchObject({
      usageReport: { state: "available" },
      input: 20,
      cacheRead: 80,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 150 },
    });
  });

  it.each([
    { eval_count: 50 },
    { prompt_eval_count: 100 },
    { prompt_eval_count: -1, eval_count: 50 },
  ])("does not promote missing or invalid counters into measured context: %j", (counters) => {
    const msg = buildAssistantMessage(
      chunk({ content: "ok" }, { done: true, ...counters }),
      MODEL_INFO,
      { input: 321, output: 123 },
    );
    expect(msg.usage.contextUsage).toBeUndefined();
  });
});

describe("createOllamaStreamFn thinking events", () => {
  it.each([[1_250_000, 2_500_000, 3.75]])(
    "retains final processing timing (%i ns + %i ns)",
    async (prompt, evalDuration, expected) => {
      const events = await streamOllamaEvents([
        {
          ...makeOllamaResponse({ content: "ok" }),
          done: false,
          prompt_eval_duration: 50_000_000,
          eval_duration: 60_000_000,
        },
        {
          ...makeOllamaResponse({}),
          prompt_eval_duration: prompt,
          eval_duration: evalDuration,
          load_duration: 900_000_000,
        },
      ]);
      expect(events.find((event) => event.type === "done")).toMatchObject({
        message: {
          diagnostics: [
            {
              type: "provider_timing",
              timestamp: expect.any(Number),
              details: { processingMs: expected },
            },
          ],
        },
      });
    },
  );

  it.each([
    { prompt_eval_duration: 1 },
    { eval_duration: 1 },
    { prompt_eval_duration: -1, eval_duration: 1 },
    { prompt_eval_duration: "1", eval_duration: 1 },
    { prompt_eval_duration: Number.MAX_VALUE, eval_duration: Number.MAX_VALUE },
  ])("omits missing, partial, or invalid final processing timing: %j", async (timing) => {
    const events = await streamOllamaEvents([
      {
        ...makeOllamaResponse({ content: "ok" }),
        done: false,
        prompt_eval_duration: 1_000_000,
        eval_duration: 2_000_000,
      },
      { ...makeOllamaResponse({}), ...timing },
    ]);
    const terminal = events.find((event) => event.type === "done");
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ message: { content: [{ type: "text", text: "ok" }] } });
    expect(terminal).not.toHaveProperty("message.diagnostics");
  });

  it.each([undefined, "Private reasoning"])(
    "keeps native tool narration unsigned with reasoning %s",
    async (thinking) => {
      const path = "README.md";
      const events = await streamOllamaEvents(
        [
          { ...makeOllamaResponse({ content: "Let me ", thinking }), done: false },
          { ...makeOllamaResponse({ content: "read README.md." }), done: false },
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
      const done = events.find((event) => event.type === "done");
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe("Let me read README.md.");
      expect(events.find((event) => event.type === "toolcall_delta")).toMatchObject({
        partial: {
          content: expect.arrayContaining([
            expect.objectContaining({ partialJson: JSON.stringify({ path }) }),
          ]),
        },
      });
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
        { ...makeOllamaResponse({ content: "Visible answer" }), done: false },
        makeOllamaResponse({ thinking: "Late reasoning", done_reason }),
      ]);
      expect(events.find((event) => event.type === "done")).toMatchObject({
        reason: done_reason,
        message: {
          stopReason: done_reason,
          content: [
            { type: "thinking", thinking: "Late reasoning" },
            { type: "text", text: "Visible answer" },
          ],
        },
      });
      const done = events.find((event) => event.type === "done");
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
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    const thinkingStartIndex = eventTypes.indexOf("thinking_start");
    const textStartIndex = eventTypes.indexOf("text_start");
    expect(thinkingStartIndex).toBeLessThan(textStartIndex);

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    expect(thinkingEndIndex).toBeLessThan(textStartIndex);

    expect(events.filter((e) => e.type === "thinking_delta").map((e) => e.delta)).toEqual([
      "Step 1",
      " and step 2",
    ]);

    const thinkingStart = events.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(0);
    const textStart = events.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(1);

    const done = events.find((e) => e.type === "done");
    const content = done?.message?.content ?? [];
    expect(content[0]).toEqual({ type: "thinking", thinking: "Step 1 and step 2" });
    expect(content[1]).toEqual({ type: "text", text: "The answer" });
  });

  it.each([
    {
      format: "bracketed",
      name: "mempalace_mempalace_search",
      raw: '[mempalace_mempalace_search]\n{"query":"codename","wing":"personal","room":"identities"}\n[END_TOOL_REQUEST]',
      args: { query: "codename", wing: "personal", room: "identities" },
      parameters: { type: "object", properties: {} },
    },
    {
      format: "Harmony",
      name: "read",
      raw: 'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}',
      args: { path: "/path/to/file", line_start: 1, line_end: 400 },
      parameters: { type: "object" },
    },
  ])(
    "promotes standalone $format local-model tool text to a structured tool call",
    async ({ name, raw, args, parameters }) => {
      const events = await streamOllamaEvents(
        [chunk({ content: raw }), terminalChunk({ prompt_eval_count: 10, eval_count: 5 })],
        {},
        {
          messages: [{ role: "user", content: "test", timestamp: 0 }],
          tools: [{ name, description: name, parameters }],
        },
      );
      expect(events.map((event) => event.type)).toEqual([
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
      expect(events.find((event) => event.type === "done")).toMatchObject({
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
        tools: [{ name: "exec", description: "Run a command", parameters: Type.Object({}) }],
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events.find((event) => event.type === "done")).toMatchObject({
      reason: "stop",
      message: { stopReason: "stop", content: [{ type: "text", text }] },
    });
  });

  it("yields to the event loop while processing dense native stream chunks", async () => {
    const chunks = denseChunks();
    const stream = startMockStream(chunks);

    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    let yieldedBeforeDone = false;
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      if (timerFired && event.type !== "done") {
        yieldedBeforeDone = true;
      }
    }
    await timerPromise;

    expect(yieldedBeforeDone).toBe(true);
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
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(makeNdjsonBody(chunks), { status: 200 }),
      release: vi.fn(async () => undefined),
      refreshTimeout,
    });

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      STREAM_MODEL,
      { messages: [{ role: "user", content: "test" }] } as never,
      { signal: controller.signal },
    );

    const events: Array<{ type: string }> = [];
    try {
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "done")).toBe(true);
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
    let returnSuccess = false;
    let receivedConfiguredHeader: string | undefined;
    let receivedAuthorization: string | undefined;
    await withNativeServer(
      (request, response) => {
        const configuredHeader = request.headers["x-proxy-auth"];
        receivedConfiguredHeader =
          typeof configuredHeader === "string" ? configuredHeader : undefined;
        receivedAuthorization = request.headers.authorization;
        if (returnSuccess) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(`${JSON.stringify(makeOllamaResponse({ content: "success control" }))}\n`);
          return;
        }
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
        expect(receivedConfiguredHeader).toBe(configuredSecret);
        expect(receivedAuthorization).toBe(`Bearer ${bearerCredential}`);
        expect(errorEvent?.error?.errorMessage).toMatch(/^429\b/);
        expect(errorEvent?.error?.errorMessage).toContain("rate limit exceeded");
        expect(errorEvent?.error?.errorMessage).not.toContain(configuredSecret);
        expect(errorEvent?.error?.errorMessage).not.toContain(bearerCredential);

        returnSuccess = true;
        const successEvents = await requestEvents(streamFn, { apiKey: bearerCredential });
        expect(successEvents.some((event) => event.type === "done")).toBe(true);
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
    const chunks = denseChunks();
    const controller = new AbortController();
    const stream = startMockStream(chunks, { signal: controller.signal });

    setTimeout(() => {
      controller.abort();
    }, 0);

    const events = await readEvents(stream);

    const lastEvent = events.at(-1);
    expect(lastEvent).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { stopReason: "aborted" },
    });
  });

  it("uses CJK-aware fallback usage while preserving missing cache provenance", async () => {
    const events = await streamOllamaEvents(
      [chunk({ content: "你好世界测试" }), terminalChunk()],
      {},
      {
        messages: [{ role: "user", content: "这是一个测试用的句子呢" }],
      } as never,
    );

    const done = events.find((event) => event.type === "done");
    expect(done?.message?.usage).toMatchObject({
      input: 12,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      cacheTelemetry: { state: "unavailable" },
    });
  });

  it.each([
    [77, 19, 77, 19],
    [0, 0, 0, 0],
    [undefined, 19, 12, 19],
    [77, undefined, 77, 6],
    [-1, 19, 12, 19],
    [77, -1, 77, 6],
  ])(
    "resolves provider counters %s/%s independently of CJK estimates",
    async (promptCount, completionCount, expectedInput, expectedOutput) => {
      const events = await streamOllamaEvents(
        [
          chunk({ content: "你好世界测试" }),
          terminalChunk({ prompt_eval_count: promptCount, eval_count: completionCount }),
        ],
        {},
        { messages: [{ role: "user", content: "这是一个测试用的句子呢" }] } as never,
      );

      const done = events.find((event) => event.type === "done");
      expect(done?.message?.usage).toMatchObject({
        input: expectedInput,
        output: expectedOutput,
        cacheTelemetry: { state: "unavailable" },
      });
    },
  );

  it("keeps the existing fallback estimate for ASCII-only usage", async () => {
    const events = await streamOllamaEvents(
      [chunk({ content: "Hello world" }), terminalChunk()],
      {},
      {
        messages: [{ role: "user", content: "The quick brown fox jumps over the lazy dog" }],
      } as never,
    );

    const done = events.find((event) => event.type === "done");
    expect(done?.message?.usage).toMatchObject({ input: 11, output: 3 });
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
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(
      JSON.stringify(
        chunk(
          { content: "ok" },
          {
            model: model.id,
            done: true,
            prompt_eval_count: 1,
            eval_count: 1,
          },
        ),
      ) + "\n",
    ),
    release: async () => undefined,
  });
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
              ? {
                  models: {
                    providers: {
                      ollama: { baseUrl: providerBaseUrl, api: "ollama", models: [] },
                    },
                  },
                }
              : undefined,
            streamFn: native,
          }),
          "wrapped stream",
        );
  expect((await (await streamFn(model, USER, {})).result()).stopReason).toBe("stop");
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
  return { url: request.url, think: JSON.parse(requestBodyText(request.init?.body)).think };
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
  baseUrl: "http://127.0.0.1:11434",
  id: "local-model",
  name: "Local model",
  provider: "custom-ollama",
  reasoning: false,
  contextWindow: 200_000,
};

describe("native Ollama output guards", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      finalUrl: "http://127.0.0.1:11434/api/chat",
      response: new Response(
        JSON.stringify({
          model: "local-model",
          message: { role: "assistant", content: "ok" },
          done: true,
        }) + "\n",
      ),
      release: async () => {},
    });
  });

  it.each<{
    name: string;
    model?: Partial<ProviderRuntimeModel>;
    maxTokens?: number;
    expected: number;
  }>([
    { name: "resolved model cap", model: { maxTokens: 3072 }, expected: 3072 },
    { name: "authored native cap", model: { params: { num_predict: 123 } }, expected: 123 },
    { name: "authored unlimited sentinel", model: { params: { num_predict: -1 } }, expected: -1 },
    {
      name: "explicit runtime cap over authored defaults",
      model: { maxTokens: 3072, params: { num_predict: 123 } },
      maxTokens: 55,
      expected: 55,
    },
    {
      name: "explicit runtime cap above model metadata",
      model: { maxTokens: 3072 },
      maxTokens: 4096,
      expected: 4096,
    },
  ])("sends $name as num_predict", async ({ model: overrides, maxTokens, expected }) => {
    const model = { ...outputModel, ...overrides };
    const stream = await createOllamaStreamFn(model.baseUrl)(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { maxTokens },
    );
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "stop" });
    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(request?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(requestBodyText(request?.init?.body))).toMatchObject({
      options: { num_predict: expected },
    });
  });

  it.each(["minimax-m3", "kimi-k3"])(
    "sends the local default for a bare %s catalog collision",
    async (id) => {
      const definition = buildOllamaModelDefinition(id);
      const model = { ...outputModel, id, maxTokens: definition.maxTokens };
      const stream = await createOllamaStreamFn(model.baseUrl)(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      });
      await stream.result();
      expect(
        JSON.parse(requestBodyText(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init?.body)),
      ).toMatchObject({
        options: { num_predict: 8192 },
      });
    },
  );

  it("replays preserved blocks and the repetition marker through the native request", async () => {
    const stream = await createOllamaStreamFn(outputModel.baseUrl)(outputModel, {
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
    });
    await stream.result();
    expect(
      JSON.parse(requestBodyText(fetchWithSsrFGuardMock.mock.calls[0]?.[0].init?.body)).messages,
    ).toEqual([
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
