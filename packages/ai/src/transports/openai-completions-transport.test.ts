import { createServer } from "node:http";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { OpenAICompletionsOptions } from "../provider-options.js";
import type { AssistantMessageEvent, Model, ToolCall } from "../types.js";
import { isContextOverflow } from "../utils/overflow.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import * as completionsStream from "./openai-completions-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  makeCompletionsChunk,
  createAssistantOutput,
  createDeepSeekCompletionsModel,
  makeCompletionsModel,
  neverYieldsStream,
} from "./openai-completions.test-support.js";
import { buildOpenAISdkRequestOptions } from "./openai-transport-params.js";

async function runBudgetResponse(params: {
  finishReason?: "stop" | "length" | "tool_calls" | null;
  model?: Partial<Model<"openai-completions">> & { params?: Record<string, unknown> };
  options?: Pick<OpenAICompletionsOptions, "maxTokens" | "onPayload" | "onResponse" | "signal">;
  chunks?: ChatCompletionChunk[];
  done?: boolean;
}) {
  const previousHost = getAiTransportHost();
  let request: Record<string, unknown> | undefined;
  const chunks = params.chunks ?? [
    makeCompletionsChunk({ content: "OK" }, params.finishReason ?? "length", {
      usage: { prompt_tokens: 8_000, completion_tokens: 1, total_tokens: 8_001 },
    }),
  ];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(await new Request(input, init).text());
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
        (params.done === false ? "" : "data: [DONE]\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  configureAiTransportHost({ ...previousHost, buildModelFetch: () => fetch });
  try {
    const model = makeCompletionsModel({
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      contextWindow: 10_000,
      maxTokens: 4_096,
      compat: { maxTokensField: "max_tokens" },
      ...params.model,
    });
    const stream = await createOpenAICompletionsTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "x".repeat(32_000), timestamp: 1 }] },
      { apiKey: "test-key", ...params.options },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(structuredClone(event));
    }
    return { result: await stream.result(), request, events, fetch };
  } finally {
    configureAiTransportHost(previousHost);
  }
}

async function captureTransportRequest(model: Model<"openai-completions">) {
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
      { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] } as never,
      { apiKey: "test-key" } as never,
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
  describe("automatic context budget compatibility", () => {
    it.each([
      [121, "max_tokens"],
      [1563, "max_tokens"],
      [121, "max_completion_tokens"],
      [1563, "max_completion_tokens"],
    ] as const)(
      "recovers an automatically reduced %i-token %s response",
      async (cap, maxTokensField) => {
        const { result, request, events } = await runBudgetResponse({
          model: { contextWindow: 10_001 + cap, compat: { maxTokensField } },
          chunks: [
            makeCompletionsChunk({ reasoning_content: "reasoning" }),
            makeCompletionsChunk({ content: "unfinished answer" }, "length", {
              usage: { prompt_tokens: 8_000, completion_tokens: cap, total_tokens: 8_000 + cap },
            }),
          ],
        });
        expect(request?.[maxTokensField]).toBe(cap);
        expect(result.stopReason).toBe("error");
        expect(isContextOverflow(result, 10_001 + cap)).toBe(true);
        expect(result.usage.output).toBe(cap);
        expect(result.content).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(["error"]);
      },
    );

    it.each([121, 1563])(
      "preserves normal stop at an automatically reduced %i-token cap",
      async (cap) => {
        const { result, request } = await runBudgetResponse({
          model: { contextWindow: 10_001 + cap },
          finishReason: "stop",
        });
        expect(request?.max_tokens).toBe(cap);
        expect(result.stopReason).toBe("stop");
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: "OK" }),
        );
      },
    );

    it.each([
      { name: "explicit options cap", options: { maxTokens: 121 } },
      { name: "explicit model params cap", model: { params: { max_tokens: 121 } } },
      { name: "model ceiling", model: { maxTokens: 121 }, options: { maxTokens: 4096 } },
      {
        name: "hook lowers cap and expands input",
        options: {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            max_tokens: 1,
            messages: [{ role: "user", content: "x".repeat(64_000) }],
          }),
        },
      },
      {
        name: "hook raises cap",
        options: {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            max_tokens: 122,
          }),
        },
      },
      {
        name: "conflicting hook cap alias",
        options: {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            max_completion_tokens: 120,
          }),
        },
      },
    ])(
      "preserves length for $name at a multi-token boundary",
      async ({ name: _name, ...params }) => {
        const { result } = await runBudgetResponse({
          ...params,
          model: { contextWindow: 10_122, ...params.model },
        });
        expect(result.stopReason).toBe("length");
        expect(isContextOverflow(result, 10_122)).toBe(false);
      },
    );

    it.each(["max_tokens", "max_completion_tokens"] as const)(
      "preserves provider stop after estimated exhaustion clamps %s to one",
      async (maxTokensField) => {
        const { result, request, events, fetch } = await runBudgetResponse({
          finishReason: "stop",
          model: { compat: { maxTokensField } },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(request?.[maxTokensField]).toBe(1);
        expect(result.stopReason).toBe("stop");
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: "OK" }),
        );
        expect(events[0]).toMatchObject({
          type: "start",
          partial: { content: [], stopReason: "stop" },
        });
        expect(events.at(-1)?.type).toBe("done");
      },
    );

    it.each([
      ["max_tokens", 10_000],
      ["max_completion_tokens", 10_001],
      ["max_tokens", 10_002],
    ] as const)(
      "recovers actual length at %s context=%i without exposing partials",
      async (maxTokensField, contextWindow) => {
        const { result, request, events, fetch } = await runBudgetResponse({
          model: { contextWindow, compat: { maxTokensField } },
          options: { onPayload: (payload) => payload },
          chunks: [
            makeCompletionsChunk({ reasoning_content: "The" }),
            makeCompletionsChunk({ content: "partial" }),
            makeCompletionsChunk({
              tool_calls: [
                {
                  index: 0,
                  id: "pending-write",
                  type: "function",
                  function: { name: "write", arguments: '{"path":"a"}' },
                },
              ],
            }),
            makeCompletionsChunk({}, "length", {
              usage: { prompt_tokens: 8_000, completion_tokens: 1, total_tokens: 8_001 },
            }),
          ],
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(request?.[maxTokensField]).toBe(1);
        expect(result.stopReason).toBe("error");
        expect(isContextOverflow(result, contextWindow)).toBe(true);
        expect(result.usage.output).toBe(1);
        expect(result.content).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(["error"]);
      },
    );

    it.each([
      { name: "explicit max one", options: { maxTokens: 1 } },
      { name: "model max one", model: { maxTokens: 1 }, options: { maxTokens: 64 } },
      { name: "configured params max one", model: { params: { max_tokens: 1 } } },
      {
        name: "native endpoint",
        model: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      },
      { name: "ordinary length", model: { contextWindow: 20_000 } },
      {
        name: "payload alone creates cap one and expands input",
        model: { contextWindow: 20_000 },
        options: {
          onPayload: (payload: unknown) => {
            const original = payload as Record<string, unknown>;
            expect(original.max_tokens).toBe(4_096);
            return {
              ...original,
              max_tokens: 1,
              messages: [{ role: "user", content: "x".repeat(64_000) }],
            };
          },
        },
      },
      {
        name: "payload raises cap",
        options: {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            max_tokens: 64,
          }),
        },
      },
      {
        name: "payload shortens input",
        options: {
          onPayload: (payload: unknown) => ({
            ...(payload as Record<string, unknown>),
            messages: [{ role: "user", content: "short" }],
          }),
        },
      },
    ])("keeps $name length semantics", async ({ name: _name, ...params }) => {
      const { result, fetch, events } = await runBudgetResponse(params);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("length");
      expect(result.content).not.toEqual([]);
      expect(isContextOverflow(result, 10_000)).toBe(false);
      expect(events.at(-1)?.type).toBe("done");
    });

    it("keeps incomplete stream errors ahead of budget recovery", async () => {
      const { result, fetch } = await runBudgetResponse({
        chunks: [makeCompletionsChunk({ content: "partial" })],
        done: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("without finish_reason");
      expect(isContextOverflow(result, 10_000)).toBe(false);
    });

    it("keeps cancellation ahead of budget recovery", async () => {
      const controller = new AbortController();
      const { result } = await runBudgetResponse({
        options: {
          signal: controller.signal,
          onResponse: () => controller.abort(),
        },
      });
      expect(result.stopReason).toBe("aborted");
      expect(isContextOverflow(result, 10_000)).toBe(false);
    });

    it("releases successful tool calls only after the buffered start snapshot", async () => {
      const { result, events } = await runBudgetResponse({
        chunks: [
          makeCompletionsChunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "write-ok",
                  type: "function",
                  function: { name: "write", arguments: '{"path":"a"}' },
                },
              ],
            },
            "tool_calls",
          ),
        ],
      });
      expect(result.stopReason).toBe("toolUse");
      expect(events[0]).toMatchObject({ type: "start", partial: { content: [] } });
      expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "toolCall", id: "write-ok", arguments: { path: "a" } }),
      );
    });

    it.each([false, true])(
      "withholds an executable async tool event before length settlement (aborted=%s)",
      async (abort) => {
        const controller = new AbortController();
        const originalProcess = completionsStream.processCompletionsStream;
        // Exercise the transport event contract directly: consumers can execute
        // async toolcall_end events before the producer returns its terminal state.
        const producer = vi
          .spyOn(completionsStream, "processCompletionsStream")
          .mockImplementation(async (response, output, model, events, options) => {
            await originalProcess(response, output, model, events, options);
            const toolCall: ToolCall = {
              type: "toolCall",
              id: "async-write",
              name: "write",
              arguments: { path: "a" },
              async: true,
            };
            output.content.push(toolCall);
            events.push({
              type: "toolcall_end",
              contentIndex: output.content.length - 1,
              toolCall,
              partial: output,
            });
            if (abort) {
              controller.abort();
              // Cancellation at the buffer boundary must not release the queued
              // async tool call while switching back to ordinary streaming.
              events.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(300_000) });
            }
          });
        try {
          const { result, events } = await runBudgetResponse({
            options: { signal: controller.signal },
          });
          expect(producer).toHaveBeenCalledTimes(1);
          expect(result.stopReason).toBe(abort ? "aborted" : "error");
          expect(isContextOverflow(result, 10_000)).toBe(!abort);
          expect(result.usage.output).toBe(1);
          expect(result.content).toEqual([]);
          expect(events.map((event) => event.type)).toEqual(["error"]);
        } finally {
          producer.mockRestore();
        }
      },
    );

    it("preserves malformed tool-call errors without releasing candidate events", async () => {
      const { result, events } = await runBudgetResponse({
        chunks: [
          makeCompletionsChunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "write-bad",
                  type: "function",
                  function: { name: "write", arguments: "{" },
                },
              ],
            },
            "tool_calls",
          ),
        ],
      });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(/incomplete|malformed/);
      expect(isContextOverflow(result, 10_000)).toBe(false);
      expect(result.content).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(["error"]);
    });

    it.each([
      {
        name: "oversized event",
        deltas: ["prefix", "x".repeat(300_000), "tail"],
      },
      {
        name: "too many events",
        deltas: Array.from({ length: 300 }, (_, index) => `${index},`),
      },
    ])("preserves stop ordering and recovers length after $name", async ({ deltas }) => {
      for (const finishReason of ["stop", "length"] as const) {
        const { result, events, request, fetch } = await runBudgetResponse({
          chunks: [
            ...deltas.map((content) => makeCompletionsChunk({ content })),
            makeCompletionsChunk({}, finishReason, {
              usage: { prompt_tokens: 8_000, completion_tokens: 1, total_tokens: 8_001 },
            }),
          ],
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(request?.max_tokens).toBe(1);
        if (finishReason === "length") {
          expect(result.stopReason).toBe("error");
          expect(isContextOverflow(result, 10_000)).toBe(true);
          expect(events.map((event) => event.type)).toEqual(["error"]);
          continue;
        }
        expect(result.stopReason).toBe(finishReason);
        expect(result.errorMessage).toBeUndefined();
        expect(result.usage.output).toBe(1);
        expect(isContextOverflow(result, 10_000)).toBe(false);
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: deltas.join("") }),
        );
        expect(events[0]).toMatchObject({ type: "start", partial: { content: [] } });
        expect(events.filter((event) => event.type === "start")).toHaveLength(1);
        expect(
          events.filter((event) => event.type === "text_delta").map((event) => event.delta),
        ).toEqual(deltas);
        expect(events.filter((event) => event.type === "done")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "done", reason: finishReason });
        expect(events.some((event) => event.type === "error")).toBe(false);
      }
    });
  });

  it("passes provider request timeouts to OpenAI SDK per-request options", () => {
    const signal = new AbortController().signal;
    const model = {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      requestTimeoutMs: 900_000.7,
    } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };

    expect(buildOpenAISdkRequestOptions(model, signal)).toEqual({
      signal,
      timeout: 900_000,
      maxRetries: 0,
    });
    expect(
      buildOpenAISdkRequestOptions(
        { ...model, requestTimeoutMs: -1 } as Model<"openai-completions">,
        undefined,
      ),
    ).toBeUndefined();
  });
  it("streams OpenAI-compatible loopback requests with the configured SDK timeout", async () => {
    let captured: { path?: string; timeout?: string; model?: string; roles?: string[] } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
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
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify(
            makeCompletionsChunk({}, "stop", {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          )}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const baseModel = {
        id: "mlx-community/Qwen3-30B-A3B-6bit",
        name: "Qwen3 MLX",
        api: "openai-completions",
        provider: "mlx",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
        requestTimeoutMs: 900_000,
      } satisfies Model<"openai-completions"> & { requestTimeoutMs: number };
      const stream = createOpenAICompletionsTransportStreamFn()(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
          tools: [],
        } as never,
        { apiKey: "test-key" } as never,
      );

      let doneReason: string | undefined;
      let text = "";
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        reason?: string;
      }>) {
        if (event.type === "text_delta") {
          text += event.delta ?? "";
        }
        if (event.type === "done") {
          doneReason = event.reason;
        }
      }

      expect(captured.path).toBe("/v1/chat/completions");
      expect(captured.timeout).toBe("900");
      expect(captured.model).toBe("mlx-community/Qwen3-30B-A3B-6bit");
      expect(captured.roles).toEqual(["system", "user"]);
      expect(doneReason).toBe("stop");
      expect(text).toBe("OK");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses ModelStudio chat streams with no user or assistant payload turns", async () => {
    const model = makeCompletionsModel({
      id: "qwen-coder-plus",
      name: "qwen-coder-plus",
      provider: "qwen",
      baseUrl: "https://modelstudio.example/v1",
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

    let errorPayload: Record<string, unknown> | undefined;
    for await (const event of stream as AsyncIterable<{
      type: string;
      error?: Record<string, unknown>;
    }>) {
      if (event.type === "error") {
        errorPayload = event.error;
      }
    }

    expect(errorPayload).toMatchObject({ stopReason: "error" });
    expect(String(errorPayload?.errorMessage)).toContain(
      "contains no non-empty user or assistant messages",
    );
    expect(String(errorPayload?.errorMessage)).toContain("system/tool-only request");
  });

  it("allows generic OpenAI-compatible chat streams without the ModelStudio turn guard", async () => {
    let capturedRoles: string[] | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        capturedRoles = parsed.messages?.map((message) => message.role ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(makeCompletionsChunk({ role: "assistant", content: "OK" }))}\n\n`,
        );
        res.write(`data: ${JSON.stringify(makeCompletionsChunk({}, "stop"))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback server address");
      }
      const model = makeCompletionsModel({
        id: "generic-openai-compatible",
        name: "Generic OpenAI Compatible",
        provider: "custom-openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails OpenAI completions streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createDeepSeekCompletionsModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = processCompletionsStream(
        neverYieldsStream() as AsyncIterable<ChatCompletionChunk>,
        createAssistantOutput(model),
        model,
        { push: vi.fn() },
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves Azure OpenAI completions api-version headers into query params", async () => {
    const request = await captureTransportRequest({
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      api: "openai-completions",
      provider: "azure-custom",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt-4o-mini?existing=1",
      headers: {
        "api-key": "azure-key",
        "api-version": "2024-10-21",
        "X-Tenant": "acme",
      },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } as unknown as Model<"openai-completions">);
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

  it("preserves configured query params without moving non-Azure headers", async () => {
    const request = await captureTransportRequest(
      makeCompletionsModel({
        id: "proxy-model",
        name: "Proxy Model",
        provider: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1?tenant=acme",
        headers: {
          "api-version": "proxy-header",
          "X-Tenant": "acme",
        },
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
      }),
    );
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe("https://proxy.example.com/v1/chat/completions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ tenant: "acme" });
    expect(request.headers.get("api-version")).toBe("proxy-header");
    expect(request.headers.get("x-tenant")).toBe("acme");
  });
});
