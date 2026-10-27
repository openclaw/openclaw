import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { streamAzureOpenAIResponses } from "../providers/azure-openai-responses.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamFn } from "../types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { collectEventTypes } from "./openai-stream-cases.test-support.js";

const openAIModel = makeProviderModel("openai-responses", "openai", "gpt-5.6-luna", {
  name: "Responses hook lifecycle",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  maxTokens: 4_096,
});

const azureModel = {
  ...openAIModel,
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://project.services.ai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

const traditionalAzureModel = {
  ...azureModel,
  baseUrl: "https://resource.openai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

const chatGptModel = {
  ...openAIModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

const chatGptToken = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-response-hook" },
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
})();

type RequestLifecycle = {
  requestAborted: ReturnType<typeof vi.fn>;
  assertListenersRemoved(): void;
};

function completedResponse(init?: ResponseInit, eventHeaders?: Record<string, string>): Response {
  const response = {
    id: "resp_response_hook",
    object: "response",
    status: "completed",
    model: openAIModel.id,
    ...(eventHeaders ? { headers: eventHeaders } : {}),
    output: [
      {
        id: "msg_response_hook",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.completed", response },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 202,
    headers: {
      "content-type": "text/event-stream",
      "x-ratelimit-remaining-requests": "42",
      "x-request-id": "req_observable",
    },
    ...init,
  });
}

function trackedFetch(responseFactory: () => Response): {
  fetch: typeof fetch;
  lifecycle: RequestLifecycle;
} {
  let addAbortListener: MockInstance<AbortSignal["addEventListener"]> | undefined;
  let removeAbortListener: MockInstance<AbortSignal["removeEventListener"]> | undefined;
  const requestAborted = vi.fn();
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener("abort", requestAborted, { once: true });
      addAbortListener = vi.spyOn(signal, "addEventListener");
      removeAbortListener = vi.spyOn(signal, "removeEventListener");
    }
    return responseFactory();
  });
  return {
    fetch: fetchMock,
    lifecycle: {
      requestAborted,
      assertListenersRemoved() {
        for (const [event, listener] of addAbortListener?.mock.calls ?? []) {
          if (event === "abort") {
            expect(removeAbortListener).toHaveBeenCalledWith("abort", listener);
          }
        }
      },
    },
  };
}

function installSdkResponse(): RequestLifecycle {
  const tracked = trackedFetch(completedResponse);
  configureAiTransportHost({ buildModelFetch: () => tracked.fetch });
  return tracked.lifecycle;
}

function installChatGptResponse(): RequestLifecycle {
  const tracked = trackedFetch(completedResponse);
  vi.stubGlobal("fetch", tracked.fetch);
  return tracked.lifecycle;
}

function createManagedFixtureStream(
  createStream: StreamFn,
  model: Model,
  options?: BaseOpenAIStreamOptions,
): AssistantMessageEventStreamLike {
  const result = createStream(model, context, { apiKey: "fixture-token", ...options });
  if (result instanceof Promise) {
    throw new Error("OpenAI Responses transport must return its event stream synchronously");
  }
  return result;
}

const managedOpenAIStream = createOpenAIResponsesTransportStreamFn();
const managedAzureStream = createAzureOpenAIResponsesTransportStreamFn();

const fixtures = {
  openai: {
    name: "SDK OpenAI",
    model: openAIModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(managedOpenAIStream, openAIModel, options),
  },
  azure: {
    name: "SDK Azure",
    model: azureModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(managedAzureStream, azureModel, options),
  },
  traditionalAzure: {
    name: "traditional SDK Azure",
    model: traditionalAzureModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(managedAzureStream, traditionalAzureModel, options),
  },
  sharedAzure: {
    name: "package Azure Responses",
    model: azureModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamAzureOpenAIResponses(azureModel, context, { apiKey: "fixture-token", ...options }),
  },
  sharedTraditionalAzure: {
    name: "package traditional Azure Responses",
    model: traditionalAzureModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamAzureOpenAIResponses(traditionalAzureModel, context, {
        apiKey: "fixture-token",
        ...options,
      }),
  },
  shared: {
    name: "shared Responses provider",
    model: openAIModel,
    installResponse: installSdkResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamOpenAIResponses(openAIModel, context, { apiKey: "fixture-token", ...options }),
  },
  chatgpt: {
    name: "native ChatGPT SSE",
    model: chatGptModel,
    installResponse: installChatGptResponse,
    createStream: (options?: BaseOpenAIStreamOptions) =>
      streamOpenAICodexResponses(chatGptModel, context, {
        apiKey: chatGptToken,
        transport: "sse",
        ...options,
      }),
  },
};

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("response hook lifecycle timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([{ id: "gpt-6-sol", api: "azure-openai-responses" }] as const)(
  "preserves $id sampling on the managed $api route",
  async ({ id, api }) => {
    let requestBody: unknown;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requestBody = await new Request(input, init).json();
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    });
    configureAiTransportHost({ buildModelFetch: () => fetchMock });

    const stream = createManagedFixtureStream(
      managedAzureStream,
      { ...azureModel, id, api },
      { temperature: 0.5, topP: 0.8 },
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestBody).toMatchObject({ model: id, temperature: 0.5, top_p: 0.8 });
  },
);

it("preserves the turn encoding over environment headers on the final OpenAI SDK request", async () => {
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "Accept-Encoding: deflate");
  const fetchMock = vi.fn<typeof fetch>(async () => completedResponse());
  configureAiTransportHost({
    buildModelFetch: () => fetchMock,
    plugin: {
      ...previousHost.plugin,
      resolveTransportTurnState: () => ({ headers: { "Accept-Encoding": "gzip, br" } }),
    },
  });
  const stream = createManagedFixtureStream(managedOpenAIStream, openAIModel);
  expect((await stream.result()).stopReason).toBe("stop");
  expect(fetchMock).toHaveBeenCalledOnce();
  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(headers.get("accept-encoding")).toBe("gzip, br");
});

describe.each([fixtures.azure, fixtures.chatgpt])(
  "$name response hook",
  ({ createStream, installResponse, model }) => {
    it("awaits response metadata before exposing the first stream event", async () => {
      installResponse();
      const order: string[] = [];
      const hookCompleted = createDeferred();
      const onResponse = vi.fn(async () => {
        order.push("hook:start");
        await hookCompleted.promise;
        order.push("hook:end");
      });
      const stream = createStream({ onResponse });
      const consume = collectEventTypes(stream, order);

      await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
      expect(order).toEqual(["hook:start"]);
      expect(onResponse).toHaveBeenCalledWith(
        {
          status: 202,
          headers: {
            "content-type": "text/event-stream",
            "x-ratelimit-remaining-requests": "42",
            "x-request-id": "req_observable",
          },
        },
        model,
      );

      hookCompleted.resolve();
      await consume;
      expect((await stream.result()).stopReason).toBe("stop");
      expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
    });
  },
);

describe.each([fixtures.shared])("$name response hook", ({ createStream, installResponse }) => {
  it("applies the first-event timeout while the hook is pending", async () => {
    const lifecycle = installResponse();
    const onFirstEventTimeout = vi.fn();
    const onResponse = vi.fn(() => new Promise<void>(() => {}));
    const stream = createStream({
      firstEventTimeoutMs: 20,
      onFirstEventTimeout,
      onResponse,
    });
    const eventTypes: string[] = [];
    const consume = collectEventTypes(stream, eventTypes);
    const result = await settleWithin(stream.result());
    await consume;

    expect(onResponse).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /responses HTTP stream opened but did not deliver a first SSE event within 20ms/,
    );
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(eventTypes).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
    lifecycle.assertListenersRemoved();
  });
});

describe.each([fixtures.openai, fixtures.chatgpt])(
  "$name response hook",
  ({ createStream, installResponse }) => {
    it.each(["resolve", "reject"] as const)(
      "keeps caller cancellation terminal after a late hook %s",
      async (settlement) => {
        const lifecycle = installResponse();
        const controller = new AbortController();
        const pendingHook = createDeferred();
        const onResponse = vi.fn(() => pendingHook.promise);
        const stream = createStream({ signal: controller.signal, onResponse });
        const eventTypes: string[] = [];
        const consume = collectEventTypes(stream, eventTypes);

        await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
        const abortReason = Object.assign(new Error("caller canceled the provider response"), {
          code: "CALLER_ABORTED",
        });
        controller.abort(abortReason);
        const result = await settleWithin(stream.result());
        await consume;
        expect(result).toMatchObject({
          stopReason: "aborted",
          errorCode: "CALLER_ABORTED",
          errorMessage: "caller canceled the provider response",
        });
        expect(eventTypes).toEqual(["error"]);
        expect(lifecycle.requestAborted).toHaveBeenCalledOnce();

        if (settlement === "resolve") {
          pendingHook.resolve();
        } else {
          pendingHook.reject(new Error("late response hook rejection"));
        }
        await nextEventLoopTurn();
        expect(eventTypes).toEqual(["error"]);
        lifecycle.assertListenersRemoved();
      },
    );
  },
);

describe("managed ChatGPT OAuth response model", () => {
  it("preserves the concrete model reported by managed SSE event headers", async () => {
    const responseModel = "gpt-5.6-luna-2026-08-02";
    const tracked = trackedFetch(() =>
      completedResponse(undefined, { "x-openai-model": responseModel }),
    );
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });

    const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();

    expect(result.responseModel).toBe(responseModel);
  });

  it("fails closed when one managed SSE event has conflicting model attestations", async () => {
    const tracked = trackedFetch(() =>
      completedResponse(undefined, {
        "openai-model": "gpt-5.6-sol",
        "x-openai-model": "gpt-5.6-terra-2026-08-01",
      }),
    );
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });

    const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Conflicting OpenAI response model attestations",
    });
    expect(result.responseModel).toBeUndefined();
  });

  it("fails closed when repeated managed HTTP model headers conflict", async () => {
    const headers = new Headers({ "openai-model": "gpt-5.6-sol" });
    headers.append("openai-model", "gpt-5.6-terra-2026-08-01");
    const tracked = trackedFetch(() => completedResponse({ headers }));
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });

    const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Conflicting OpenAI response model attestations",
    });
    expect(result.responseModel).toBeUndefined();
  });
});

describe.each(Object.values(fixtures))("$name non-success response hooks", ({ createStream }) => {
  it("reports the rejection before body consumption while another request completes", async () => {
    // The embedded runner owns transient retries; the transport must expose
    // the first non-success response to the hook and then fail the stream.
    const response = new Response("overloaded", {
      status: 503,
      headers: { "retry-after-ms": "0" },
    });
    const readBody = vi.spyOn(response, "text");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(completedResponse());
    configureAiTransportHost({ buildModelFetch: () => fetchMock });
    vi.stubGlobal("fetch", fetchMock);
    const parallelOnResponse = vi.fn<NonNullable<BaseOpenAIStreamOptions["onResponse"]>>();
    const bodyReadsDuringHook: number[] = [];
    let requestsBeforeParallel: number | undefined;
    let parallelStopReason: string | undefined;
    const onResponse = vi.fn<NonNullable<BaseOpenAIStreamOptions["onResponse"]>>(async () => {
      bodyReadsDuringHook.push(readBody.mock.calls.length);
      requestsBeforeParallel = fetchMock.mock.calls.length;
      const parallel = await createStream({
        sessionId: "response-hook-overlap",
        onResponse: parallelOnResponse,
      }).result();
      parallelStopReason = parallel.stopReason;
      bodyReadsDuringHook.push(readBody.mock.calls.length);
    });

    const result = await createStream({ sessionId: "response-hook-overlap", onResponse }).result();

    expect(result.stopReason).toBe("error");
    expect(onResponse.mock.calls.map(([metadata]) => metadata.status)).toEqual([503]);
    expect(parallelOnResponse.mock.calls.map(([metadata]) => metadata.status)).toEqual([202]);
    expect(parallelStopReason).toBe("stop");
    expect(bodyReadsDuringHook).toEqual([0, 0]);
    expect(requestsBeforeParallel).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("native ChatGPT SSE non-success response hooks", () => {
  it("times out a stalled non-success hook and cancels its body", async () => {
    const bodyCancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel: bodyCancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 })),
    );
    const onFirstEventTimeout = vi.fn();

    const result = await settleWithin(
      streamOpenAICodexResponses(chatGptModel, context, {
        apiKey: chatGptToken,
        transport: "sse",
        firstEventTimeoutMs: 20,
        onFirstEventTimeout,
        onResponse: () => new Promise<void>(() => {}),
      }).result(),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /responses HTTP stream opened but did not deliver a first SSE event within 20ms/,
    );
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(bodyCancelled).toHaveBeenCalledOnce();
  });
});
