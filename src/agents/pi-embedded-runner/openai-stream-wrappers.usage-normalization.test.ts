import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompletionsUsageNormalizationWrapper } from "./openai-stream-wrappers.js";

describe("createOpenAICompletionsUsageNormalizationWrapper", () => {
  const model: Model<"openai-completions"> = {
    api: "openai-completions",
    provider: "custom",
    id: "test-model",
    baseUrl: "http://127.0.0.1:8000/v1",
  } as Model<"openai-completions">;

  const context: Context = { messages: [] };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips wrapping for non-openai-completions APIs", () => {
    const baseStreamFn: StreamFn = vi.fn((_m, _c, _o) => createAssistantMessageEventStream());
    const wrapped = createOpenAICompletionsUsageNormalizationWrapper(baseStreamFn);

    const responsesModel = {
      ...model,
      api: "openai-responses",
    } as Model<"openai-responses">;

    void wrapped(responsesModel, context, undefined);
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("installs and uninstalls fetch wrapper for openai-completions", async () => {
    const savedFetch = globalThis.fetch;
    const stream = createAssistantMessageEventStream();

    const baseStreamFn: StreamFn = vi.fn((_m, _c, _o) => {
      // Fetch should be wrapped at this point.
      expect(globalThis.fetch).not.toBe(savedFetch);
      // Push a done event so result() resolves.
      stream.push({
        type: "done",
        message: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "custom",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      return stream;
    });

    const wrapped = createOpenAICompletionsUsageNormalizationWrapper(baseStreamFn);
    const resultStream = wrapped(model, context, undefined);

    // The stream should have been created with fetch wrapper in place.
    expect(baseStreamFn).toHaveBeenCalledOnce();

    // Wait for result to trigger cleanup.
    const result = await (
      resultStream as ReturnType<typeof createAssistantMessageEventStream>
    ).result();
    expect(result).toBeDefined();

    // Fetch should be restored.
    expect(globalThis.fetch).toBe(savedFetch);
  });

  it("normalizes input_tokens/output_tokens in SSE response body", async () => {
    // Build a fake SSE response body with mlx-vlm-style usage fields.
    const sseData = [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const sseBlob = new Blob([sseData], { type: "text/event-stream" });
    const mockResponse = new Response(sseBlob.stream(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    // Capture what the wrapped fetch returns.
    const realFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = mockFetch;

    try {
      const stream = createAssistantMessageEventStream();

      const baseStreamFn: StreamFn = (_m, _c, _o) => {
        // At this point, fetch is wrapped by our normalizer.
        // Simulate what pi-ai does: call fetch and read SSE.
        const wrappedFetch = globalThis.fetch;

        // Fire off the fetch and read the response.
        void (async () => {
          const response = await wrappedFetch("http://127.0.0.1:8000/v1/chat/completions", {
            method: "POST",
          });

          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let text = "";
          let done = false;
          while (!done) {
            const chunk = await reader.read();
            done = chunk.done;
            if (chunk.value) {
              text += decoder.decode(chunk.value, { stream: true });
            }
          }

          // Verify the SSE data was normalized: prompt_tokens/completion_tokens
          // should have been added.
          expect(text).toContain('"prompt_tokens":11');
          expect(text).toContain('"completion_tokens":5');
          // Original fields should still be present.
          expect(text).toContain('"input_tokens":11');
          expect(text).toContain('"output_tokens":5');

          stream.push({
            type: "done",
            message: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "custom",
              model: "test-model",
              usage: {
                input: 11,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 16,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          });
        })();

        return stream;
      };

      const wrapped = createOpenAICompletionsUsageNormalizationWrapper(baseStreamFn);
      const resultStream = wrapped(model, context, undefined);
      await (resultStream as ReturnType<typeof createAssistantMessageEventStream>).result();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not modify SSE data when standard fields are already present", async () => {
    const sseData =
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}\n\n';

    const sseBlob = new Blob([sseData], { type: "text/event-stream" });
    const mockResponse = new Response(sseBlob.stream(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const realFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    globalThis.fetch = mockFetch;

    try {
      const stream = createAssistantMessageEventStream();

      const baseStreamFn: StreamFn = (_m, _c, _o) => {
        const wrappedFetch = globalThis.fetch;

        void (async () => {
          const response = await wrappedFetch("http://localhost/v1/chat/completions", {
            method: "POST",
          });

          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let text = "";
          let done = false;
          while (!done) {
            const chunk = await reader.read();
            done = chunk.done;
            if (chunk.value) {
              text += decoder.decode(chunk.value, { stream: true });
            }
          }

          // Standard fields should be unchanged.
          expect(text).toContain('"prompt_tokens":50');
          expect(text).toContain('"completion_tokens":20');
          // No input_tokens/output_tokens should appear.
          expect(text).not.toContain('"input_tokens"');
          expect(text).not.toContain('"output_tokens"');

          stream.push({
            type: "done",
            message: {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "openai",
              model: "gpt-4o",
              usage: {
                input: 50,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 70,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          });
        })();

        return stream;
      };

      const wrapped = createOpenAICompletionsUsageNormalizationWrapper(baseStreamFn);
      const resultStream = wrapped(model, context, undefined);
      await (resultStream as ReturnType<typeof createAssistantMessageEventStream>).result();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("handles concurrent streams correctly with ref counting", async () => {
    const savedFetch = globalThis.fetch;
    const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
    let streamIndex = 0;

    const baseStreamFn: StreamFn = vi.fn((_m, _c, _o) => {
      const s = streams[streamIndex++];
      s.push({
        type: "done",
        message: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "custom",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      return s;
    });

    const wrapped = createOpenAICompletionsUsageNormalizationWrapper(baseStreamFn);

    // Start two concurrent streams.
    const s1 = wrapped(model, context, undefined) as ReturnType<
      typeof createAssistantMessageEventStream
    >;
    const s2 = wrapped(model, context, undefined) as ReturnType<
      typeof createAssistantMessageEventStream
    >;

    // Fetch should be wrapped.
    expect(globalThis.fetch).not.toBe(savedFetch);

    // Complete first stream — fetch should still be wrapped.
    await s1.result();
    expect(globalThis.fetch).not.toBe(savedFetch);

    // Complete second stream — fetch should be restored.
    await s2.result();
    expect(globalThis.fetch).toBe(savedFetch);
  });
});
