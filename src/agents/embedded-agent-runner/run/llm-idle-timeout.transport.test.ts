import { createServer, type ServerResponse } from "node:http";
import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import {
  streamSimpleOpenAICompletions,
  streamSimpleOpenAIResponses,
} from "@openclaw/ai/internal/openai";
import type { FirstStreamEventInternalOptions } from "@openclaw/ai/internal/runtime";
import { afterAll, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
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

afterAll(async () => {
  await server.releaseListener();
  await server.claim.release();
});

type WatchdogPolicy = Pick<
  NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>,
  "cfg" | "trigger"
>;

async function openRequest(
  api: Api,
  modelRequestTimeoutMs?: number,
  runTimeoutMs?: number,
  policy: WatchdogPolicy = {},
) {
  const model = makeProviderModelFixture<Api>({
    id: "local-model",
    name: "Local model",
    api,
    provider: "custom-local",
    baseUrl: `http://127.0.0.1:${server.claim.port}/v1`,
    contextWindow: 8192,
    maxTokens: 128,
  });
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
  const params = { ...policy, model, modelRequestTimeoutMs, runTimeoutMs };
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

type Request = Awaited<ReturnType<typeof openRequest>>;

const it = baseIt.extend<{ open: typeof openRequest }>({
  open: async ({ signal }, use) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests: Request[] = [];
    try {
      await use(async (...args) => {
        const request = await openRequest(...args);
        requests.push(request);
        return request;
      });
    } finally {
      try {
        for (const request of requests) {
          request.controller.abort();
          await withinTest(request.completion, signal);
        }
      } finally {
        vi.useRealTimers();
        server.listener.closeAllConnections();
      }
    }
  },
});

function received(stream: Request, signal: AbortSignal) {
  return withinTest(
    awaitGateBeforeSettlement(stream.request.promise, stream.completion, "request never sent"),
    signal,
  );
}

const headerCases: [Api, number | undefined, number | undefined, number][] = [
  ["openai-responses", undefined, undefined, 300_000],
  ["openai-completions", undefined, undefined, 300_000],
  ["anthropic-messages", undefined, undefined, 300_000],
  ["ollama", undefined, undefined, 300_000],
  ["openai-responses", undefined, 900_000, 300_000],
  ["openai-responses", 900_000, undefined, 900_000],
];

describe("provider watchdog deadlines", () => {
  it.for(headerCases)(
    "aborts %s before headers (provider %s; run %s; budget %s)",
    async ([api, providerMs, runMs, expectedMs], { signal, open }) => {
      const stream = await open(api, providerMs, runMs);
      expect((await received(stream, signal)).headersSent).toBe(false);
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(stream.onTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: `LLM idle timeout (${expectedMs / 1000}s): no response from model`,
        }),
      );
      expect(await withinTest(stream.completion, signal)).toBe(stream.onTimeout.mock.calls[0]?.[0]);
      await withinTest(stream.closed.promise, signal);
    },
  );

  it.for<{
    name: string;
    remote?: boolean;
    trigger?: "cron";
    providerMs?: number;
    expectedMs: number;
  }>([
    { name: "hosted relay", remote: true, expectedMs: 120_000 },
    { name: "bounded cron relay", remote: true, trigger: "cron", expectedMs: 60_000 },
    { name: "explicit hosted timeout", remote: true, providerMs: 3_000, expectedMs: 3_000 },
    { name: "explicit local timeout", providerMs: 3_000, expectedMs: 3_000 },
  ])("aborts a stalled stream with $name policy", async (testCase, { signal, open }) => {
    const { providerMs, trigger, remote } = testCase;
    const stream = await open("openai-completions", providerMs, trigger ? 600_000 : undefined, {
      trigger,
      cfg: {
        models: {
          providers: {
            "custom-local": {
              baseUrl: `http://127.0.0.1:${server.claim.port}/v1`,
              api: "openai-completions",
              models: [],
              remote,
            },
          },
        },
      },
    });
    const response = await received(stream, signal);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"O"},"finish_reason":null}]}\n\n',
    );
    await withinTest(stream.firstText.promise, signal);
    await vi.advanceTimersByTimeAsync(testCase.expectedMs - 1);
    expect(stream.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: `LLM idle timeout (${testCase.expectedMs / 1000}s): no response from model`,
      }),
    );
    expect(await withinTest(stream.completion, signal)).toBe(stream.onTimeout.mock.calls[0]?.[0]);
    await withinTest(stream.closed.promise, signal);
  });

  it("allows a local completions stream to pause after its first event and deliver its reply", async ({
    signal,
    open,
  }) => {
    const stream = await open("openai-completions");
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
  });

  it.for(["anthropic-messages", "ollama"] as const)(
    "allows local %s prompt evaluation after headers without an outward event",
    async (api, { signal, open }) => {
      const stream = await open(api);
      const response = await withinTest(stream.request.promise, signal);
      response.writeHead(200, {
        "content-type": api === "ollama" ? "application/x-ndjson" : "text/event-stream",
      });
      response.flushHeaders();
      await withinTest(stream.accepted.promise, signal);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(stream.onTimeout).not.toHaveBeenCalled();
    },
  );

  it("preserves the OpenAI first-SSE deadline after headers", async ({ signal, open }) => {
    const stream = await open("openai-responses");
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
  });
});
