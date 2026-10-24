import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import type { FirstStreamEventInternalOptions } from "../utils/stream-first-event-timeout.js";
import {
  collectStream,
  replyContext,
  startSse,
  withServer,
  writeSse,
} from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";
import { buildOpenAISdkRequestOptions } from "./openai-transport-params.js";

async function captureTransportRequest(
  model: Model<"openai-completions">,
  tools: Context["tools"] = [],
  options: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "toolChoice"> = {},
) {
  const previousHost = getAiTransportHost();
  let captured: Request | undefined;
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (input, init) => {
      captured = new Request(input, init);
      return new Response(
        `data: ${JSON.stringify(makeCompletionsChunk({ content: "ok" }, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools },
      { apiKey: "test-key", ...options },
    );
    if (stream instanceof Promise) {
      throw new Error("OpenAI Chat transport must return its event stream synchronously");
    }
    for await (const event of stream) {
      // Consume the request through transport finalization.
      void event;
    }
    if (!captured) {
      throw new Error("Expected the transport to issue a request");
    }
    return captured;
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("openai completions transport", () => {
  it.each([
    { field: "reasoning", answer: "OK", reasoning: false, finish: "stop", terminal: "done" },
    { field: "reasoning_content", answer: "", reasoning: false, finish: "stop", terminal: "error" },
    { field: "reasoning_text", answer: "", reasoning: false, finish: "length", terminal: "error" },
    { field: "reasoning", answer: "OK", reasoning: true, finish: "stop", terminal: "done" },
  ])(
    "diagnoses suppressed $field with reasoning=$reasoning and finish=$finish",
    async (testCase) => {
      const hidden = "synthetic private thought";
      const previousHost = getAiTransportHost();
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async () =>
          new Response(
            [
              makeCompletionsChunk({ [testCase.field]: hidden }),
              makeCompletionsChunk({ content: testCase.answer }, testCase.finish),
            ]
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      try {
        const model = makeCompletionsModel({
          provider: "local",
          id: "qwen3:4b",
          baseUrl: "http://127.0.0.1:11434/v1",
          reasoning: testCase.reasoning,
        });
        const { events, text, terminal, result } = await collectStream(
          createOpenAICompletionsTransportStreamFn()(model, replyContext(), { apiKey: "test-key" }),
        );
        expect(terminal?.type).toBe(testCase.terminal);
        expect(text).toBe(testCase.answer);
        if (testCase.reasoning) {
          expect(result.diagnostics).toBeUndefined();
          expect(events.some((event) => event.type === "thinking_delta")).toBe(true);
        } else {
          expect(JSON.stringify(result)).not.toContain(hidden);
          expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
          expect(result.diagnostics).toEqual([
            { type: "reasoning_suppressed", timestamp: expect.any(Number) },
          ]);
          if (testCase.terminal === "error") {
            expect(result.errorMessage).toContain("reasoning: true");
            expect(result.errorMessage).toContain("local/qwen3:4b");
          }
        }
      } finally {
        configureAiTransportHost(previousHost);
      }
    },
  );

  it.each([
    ["official OpenAI", "https://api.openai.com/v1", true],
    ["OpenAI-compatible proxy", "https://proxy.example.com/v1", false],
  ] as const)("routes %s reasoning tool turns", async (_endpoint, baseUrl, native) => {
    const request = await captureTransportRequest(
      makeCompletionsModel({ id: "gpt-5.6-sol", provider: "openai-api", baseUrl }),
      [{ name: "read", description: "", parameters: {} }],
      { toolChoice: { type: "function", function: { name: "read" } } },
    );
    const body = await request.json();
    expect(new URL(request.url).pathname).toBe(native ? "/v1/responses" : "/v1/chat/completions");
    expect(body.tool_choice).toEqual(
      native
        ? { type: "function", name: "read" }
        : { type: "function", function: { name: "read" } },
    );
    expect(body.reasoning?.effort).toBe(native ? "high" : undefined);
  });

  it("passes provider request timeouts to OpenAI SDK per-request options", () => {
    const signal = new AbortController().signal;
    const model = {
      ...makeCompletionsModel(),
      requestTimeoutMs: 900_000.7,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
      maxRetries: 0,
    });
    const invalid = { ...model, requestTimeoutMs: -1 };
    expect(buildOpenAISdkRequestOptions(invalid, undefined)).toBeUndefined();
  });
  it("streams OpenAI-compatible loopback requests with the configured SDK timeout", async () => {
    let captured: { path?: string; timeout?: string; model?: string; roles?: string[] } = {};
    await withServer(
      (req, res, body) => {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ role?: string }>;
        };
        captured = {
          path: req.url,
          timeout: Array.isArray(req.headers["x-stainless-timeout"])
            ? req.headers["x-stainless-timeout"][0]
            : req.headers["x-stainless-timeout"],
          model: parsed.model,
          roles: parsed.messages?.map((message) => message.role ?? ""),
        };
        startSse(res, true);
        writeSse(res, makeCompletionsChunk({ role: "assistant", content: "OK" }));
        writeSse(
          res,
          makeCompletionsChunk({}, "stop", {
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      },
      async (baseUrl) => {
        const baseModel = {
          ...makeCompletionsModel({
            id: "mlx-community/Qwen3-30B-A3B-6bit",
            provider: "mlx",
            baseUrl,
            reasoning: false,
          }),
          requestTimeoutMs: 900_000,
        } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };
        const stream = createOpenAICompletionsTransportStreamFn()(
          baseModel,
          replyContext("Reply OK"),
          { apiKey: "test-key" },
        );
        const { text, terminal } = await collectStream(stream);
        expect(captured).toMatchObject({
          path: "/v1/chat/completions",
          timeout: "900",
          model: "mlx-community/Qwen3-30B-A3B-6bit",
          roles: ["system", "user"],
        });
        expect(terminal).toMatchObject({ type: "done", reason: "stop" });
        expect(text).toBe("OK");
      },
    );
  });

  it("refuses ModelStudio chat streams with no user or assistant payload turns", async () => {
    const model = makeCompletionsModel({
      id: "qwen-coder-plus",
      provider: "qwen",
      baseUrl: "https://modelstudio.example/v1",
      reasoning: false,
    });
    const stream = createOpenAICompletionsTransportStreamFn()(
      model,
      { systemPrompt: "runtime-only system prompt", messages: [], tools: [] },
      { apiKey: "test-key" },
    );

    const { terminal } = await collectStream(stream);
    const errorPayload = terminal?.type === "error" ? terminal.error : undefined;

    expect(errorPayload).toMatchObject({ stopReason: "error" });
    expect(String(errorPayload?.errorMessage)).toContain(
      "contains no non-empty user or assistant messages",
    );
    expect(String(errorPayload?.errorMessage)).toContain("system/tool-only request");
  });

  it("allows generic OpenAI-compatible chat streams without the ModelStudio turn guard", async () => {
    let capturedRoles: string[] | undefined;
    await withServer(
      (_req, res, body) => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        capturedRoles = parsed.messages?.map((message) => message.role ?? "");
        startSse(res, true);
        writeSse(res, makeCompletionsChunk({ role: "assistant", content: "OK" }));
        writeSse(res, makeCompletionsChunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({
          id: "generic-openai-compatible",
          name: "Generic OpenAI Compatible",
          provider: "custom-openai-compatible",
          baseUrl,
          reasoning: false,
          contextWindow: 4096,
          maxTokens: 256,
        });
        const stream = createOpenAICompletionsTransportStreamFn()(
          model,
          {
            systemPrompt: "runtime-only system prompt",
            messages: [],
            tools: [],
          } as never,
          { apiKey: "test-key" } as never,
        );

        let doneReason: string | undefined;
        for await (const event of stream as AsyncIterable<{ type: string; reason?: string }>) {
          if (event.type === "done") {
            doneReason = event.reason;
          }
        }

        expect(capturedRoles).toEqual(["system"]);
        expect(doneReason).toBe("stop");
      },
    );
  });

  it("fails OpenAI completions streams when headers arrive but no first event follows", async () => {
    const previousHost = getAiTransportHost();
    const responseReady = Promise.withResolvers<void>();
    const requestAborted = vi.fn();
    let closeBody: (() => void) | undefined;
    configureAiTransportHost({
      ...previousHost,
      buildModelFetch: () => async (_input, init) => {
        init?.signal?.addEventListener("abort", requestAborted, { once: true });
        return new Response(
          new ReadableStream({
            start(controller) {
              closeBody = () => controller.close();
            },
            cancel() {
              closeBody = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    vi.useFakeTimers();
    try {
      const onFirstEventTimeout = vi.fn();
      const options: SimpleStreamOptions & FirstStreamEventInternalOptions = {
        apiKey: "test-key",
        firstEventTimeoutMs: 5,
        onFirstEventTimeout,
        onResponse: () => responseReady.resolve(),
      };
      const stream = createOpenAICompletionsTransportStreamFn()(
        makeCompletionsModel(),
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        options,
      );
      if (stream instanceof Promise) {
        throw new Error("OpenAI Chat transport must return its event stream synchronously");
      }

      await responseReady.promise;
      await vi.advanceTimersByTimeAsync(5);
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );
      expect(requestAborted).toHaveBeenCalledTimes(1);
      expect(onFirstEventTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    } finally {
      closeBody?.();
      configureAiTransportHost(previousHost);
      vi.useRealTimers();
    }
  });

  it("moves Azure OpenAI completions api-version headers into query params", async () => {
    const request = await captureTransportRequest(
      makeCompletionsModel({
        id: "gpt-4o-mini",
        provider: "azure-custom",
        baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini?existing=1",
        headers: { "api-key": "azure-key", "api-version": "2024-10-21", "X-Tenant": "acme" },
        reasoning: false,
      }),
    );
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(
      "https://example.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      existing: "1",
      "api-version": "2024-10-21",
    });
    expect(request.headers.get("api-key")).toBe("azure-key");
    expect(request.headers.get("x-tenant")).toBe("acme");
    expect(request.headers.has("api-version")).toBe(false);
  });
});
