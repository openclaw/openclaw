import { createServer, type ServerResponse } from "node:http";
import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import {
  streamSimpleOpenAICompletions,
  streamSimpleOpenAIResponses,
} from "@openclaw/ai/internal/openai";
import type { FirstStreamEventInternalOptions } from "@openclaw/ai/internal/runtime";
import type { Model } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import type { StreamFn } from "../../runtime/index.js";
import { recoverAfterTransportDrop } from "./attempt-recovery.test-support.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";

const { createOllamaStreamFn } = await loadBundledPluginFacade<{
  createOllamaStreamFn: (baseUrl: string) => StreamFn;
}>({ pluginId: "ollama", artifactBasename: "runtime-api.js" });

const providers = {
  "openai-responses": (model, context, options) =>
    streamSimpleOpenAIResponses({ ...model, api: "openai-responses" }, context, options),
  "openai-completions": (model, context, options) =>
    streamSimpleOpenAICompletions({ ...model, api: "openai-completions" }, context, options),
  "anthropic-messages": (model, context, options) =>
    streamSimpleAnthropic({ ...model, api: "anthropic-messages" }, context, options),
  ollama: (model, context, options) => createOllamaStreamFn(model.baseUrl)(model, context, options),
} satisfies Record<string, StreamFn>;
type Api = keyof typeof providers;

let server: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
let receive: (response: ServerResponse) => void;

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        request.on("end", () => receive(response));
        request.resume();
      }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  server.listener.closeAllConnections();
});

afterAll(async () => {
  await server.releaseListener();
  await server.claim.release();
});

async function openRequest(api: Api, modelRequestTimeoutMs?: number, runTimeoutMs?: number) {
  const model: Model<Api> = {
    id: "local-model",
    name: "Local model",
    api,
    provider: "custom-local",
    baseUrl: `http://127.0.0.1:${server.claim.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
  };
  const request = createDeferred<ServerResponse>();
  const closed = createDeferred();
  receive = (response) => {
    response.on("close", () => closed.resolve());
    request.resolve(response);
  };
  const controller = new AbortController();
  const accepted = createDeferred();
  const firstText = createDeferred();
  const onTimeout = vi.fn<(error: Error) => void>();
  const params = { model, modelRequestTimeoutMs, runTimeoutMs };
  const idleMs = resolveLlmIdleTimeoutMs(params);
  const firstMs = resolveLlmFirstEventTimeoutMs(params);
  const options: NonNullable<Parameters<StreamFn>[2]> & FirstStreamEventInternalOptions = {
    apiKey: "test-key",
    signal: controller.signal,
    timeoutMs: modelRequestTimeoutMs,
    firstEventTimeoutMs: firstMs,
    onFirstEventTimeout: onTimeout,
    onResponse: () => accepted.resolve(),
  };
  const stream = await streamWithIdleTimeout(providers[api], idleMs || firstMs, onTimeout, {
    scope: idleMs ? "creation-and-gaps" : "creation-only",
  })(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, options);
  const completion = (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "error") {
          return event.error;
        }
        if (event.type === "text_delta") {
          firstText.resolve();
        }
      }
      return stream.result();
    } catch (error) {
      return error;
    }
  })();
  return { request, closed, accepted, firstText, onTimeout, controller, completion };
}

describe("provider header deadline", () => {
  it.for(Object.keys(providers) as Api[])(
    "aborts a local %s request with no response headers at 300 seconds",
    async (api, { signal }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stream = await openRequest(api);
      try {
        const response = await withinTest(
          awaitGateBeforeSettlement(
            stream.request.promise,
            stream.completion,
            "request never sent",
          ),
          signal,
        );
        expect(response.headersSent).toBe(false);
        await vi.advanceTimersByTimeAsync(299_999);
        expect(stream.onTimeout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "LLM idle timeout (300s): no response from model" }),
        );
        expect(await withinTest(stream.completion, signal)).toBe(
          stream.onTimeout.mock.calls[0]?.[0],
        );
        await withinTest(stream.closed.promise, signal);
        if (api === "openai-responses") {
          const recovering = recoverAfterTransportDrop({
            noTools: true,
            diagnostics: [],
            content: [],
            replaySafe: true,
            errorMessage: stream.onTimeout.mock.calls[0]?.[0].message,
            terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
          });
          await vi.advanceTimersByTimeAsync(10_000);
          const recovery = await withinTest(recovering, signal);
          expect(recovery.recovery).toMatchObject({
            action: "retry",
            lastRetryFailoverReason: "timeout",
          });
          expect(recovery.onAgentEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              stream: "run_status",
              data: expect.objectContaining({ phase: "retrying", retryAttempt: 1 }),
            }),
          );
        }
      } finally {
        stream.controller.abort();
        await withinTest(stream.completion, signal);
      }
    },
  );

  it.for([
    { providerMs: undefined, runMs: 900_000, expectedMs: 300_000 },
    { providerMs: 900_000, runMs: undefined, expectedMs: 900_000 },
  ])(
    "keeps the header budget at $expectedMs ms",
    async ({ providerMs, runMs, expectedMs }, { signal }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stream = await openRequest("openai-responses", providerMs, runMs);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            stream.request.promise,
            stream.completion,
            "request never sent",
          ),
          signal,
        );
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        expect(stream.onTimeout).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(stream.onTimeout).toHaveBeenCalledOnce();
        expect(await withinTest(stream.completion, signal)).toBe(
          stream.onTimeout.mock.calls[0]?.[0],
        );
      } finally {
        stream.controller.abort();
        await withinTest(stream.completion, signal);
      }
    },
  );

  it("allows a local completions stream to pause after its first event and deliver its reply", async ({
    signal,
  }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await openRequest("openai-completions");
    try {
      const response = await withinTest(stream.request.promise, signal);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"choices":[{"index":0,"delta":{"content":"O"},"finish_reason":null}]}\n\n',
      );
      await withinTest(stream.firstText.promise, signal);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(stream.onTimeout).not.toHaveBeenCalled();
      response.end(
        'data: {"choices":[{"index":0,"delta":{"content":"K"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      expect(await withinTest(stream.completion, signal)).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "OK" }],
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(stream.onTimeout).not.toHaveBeenCalled();
    } finally {
      stream.controller.abort();
      await withinTest(stream.completion, signal);
    }
  });

  it.for(["anthropic-messages", "ollama"] as const)(
    "allows local %s prompt evaluation after headers without an outward event",
    async (api, { signal }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stream = await openRequest(api);
      try {
        const response = await withinTest(stream.request.promise, signal);
        response.writeHead(200, {
          "content-type": api === "ollama" ? "application/x-ndjson" : "text/event-stream",
        });
        response.flushHeaders();
        await withinTest(stream.accepted.promise, signal);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(stream.onTimeout).not.toHaveBeenCalled();
      } finally {
        stream.controller.abort();
        await withinTest(stream.completion, signal);
      }
    },
  );

  it("preserves the OpenAI first-SSE deadline after headers", async ({ signal }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await openRequest("openai-responses");
    try {
      const response = await withinTest(stream.request.promise, signal);
      await vi.advanceTimersByTimeAsync(200_000);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":');
      await withinTest(stream.accepted.promise, signal);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(stream.onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: expect.stringContaining("first-event timeout") }),
      );
      await withinTest(stream.completion, signal);
      await withinTest(stream.closed.promise, signal);
    } finally {
      stream.controller.abort();
      await withinTest(stream.completion, signal);
    }
  });
});
