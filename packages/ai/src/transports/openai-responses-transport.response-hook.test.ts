import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
import type { Api, AssistantMessageEventStreamLike, Context, Model } from "../types.js";
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

function installTrackedResponse(native = false): RequestLifecycle {
  const tracked = trackedFetch(completedResponse);
  if (native) {
    vi.stubGlobal("fetch", tracked.fetch);
  } else {
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });
  }
  return tracked.lifecycle;
}

function createManagedFixtureStream<TApi extends Api>(
  createStream: (
    model: Model<TApi>,
    context: Context,
    options: BaseOpenAIStreamOptions,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
  model: Model<TApi>,
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

function fixture<TApi extends Api>(
  name: string,
  model: Model<TApi>,
  stream: (
    model: Model<TApi>,
    context: Context,
    options: BaseOpenAIStreamOptions,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
  native = false,
) {
  return {
    name,
    model,
    installResponse: () => installTrackedResponse(native),
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(stream, model, {
        apiKey: native ? chatGptToken : "fixture-token",
        ...(native ? { transport: "sse" as const } : {}),
        ...options,
      }),
  };
}
const fixtures = {
  openai: fixture("SDK OpenAI", openAIModel, managedOpenAIStream),
  azure: fixture("SDK Azure", azureModel, managedAzureStream),
  traditionalAzure: fixture("traditional SDK Azure", traditionalAzureModel, managedAzureStream),
  sharedAzure: fixture("package Azure Responses", azureModel, streamAzureOpenAIResponses),
  sharedTraditionalAzure: fixture(
    "package traditional Azure Responses",
    traditionalAzureModel,
    streamAzureOpenAIResponses,
  ),
  shared: fixture("shared Responses provider", openAIModel, streamOpenAIResponses),
  chatgpt: fixture("native ChatGPT SSE", chatGptModel, streamOpenAICodexResponses, true),
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

it("preserves sampling on the managed Azure route", async () => {
  const id = "gpt-6-sol";
  let requestBody: unknown;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    requestBody = await new Request(input, init).json();
    return Response.json({ error: { message: "captured" } }, { status: 400 });
  });
  configureAiTransportHost({ buildModelFetch: () => fetchMock });

  const stream = createManagedFixtureStream(
    managedAzureStream,
    { ...azureModel, id },
    { temperature: 0.5, topP: 0.8 },
  );

  expect((await stream.result()).stopReason).toBe("error");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(requestBody).toMatchObject({ model: id, temperature: 0.5, top_p: 0.8 });
});

it("preserves turn encoding over environment headers on the final SDK request", async () => {
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
        let settleHook!: () => void;
        const pendingHook = new Promise<void>((resolve, reject) => {
          settleHook = () => {
            if (settlement === "resolve") {
              resolve();
            } else {
              reject(new Error("late response hook rejection"));
            }
          };
        });
        const onResponse = vi.fn(() => pendingHook);
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

        settleHook();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(eventTypes).toEqual(["error"]);
        lifecycle.assertListenersRemoved();
      },
    );
  },
);

it.each(["concrete SSE model", "conflicting SSE models", "conflicting HTTP models"])(
  "validates managed ChatGPT OAuth model: %s",
  async (scenario) => {
    const responseModel = "gpt-5.6-luna-2026-08-02";
    const headers = new Headers({ "openai-model": "gpt-5.6-sol" });
    headers.append("openai-model", "gpt-5.6-terra-2026-08-01");
    const tracked = trackedFetch(() =>
      scenario === "conflicting HTTP models"
        ? completedResponse({ headers })
        : completedResponse(
            undefined,
            scenario === "concrete SSE model"
              ? { "x-openai-model": responseModel }
              : { "openai-model": "gpt-5.6-sol", "x-openai-model": "gpt-5.6-terra-2026-08-01" },
          ),
    );
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });
    const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();
    if (scenario === "concrete SSE model") {
      expect(result.responseModel).toBe(responseModel);
      return;
    }
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Conflicting OpenAI response model attestations",
    });
    expect(result.responseModel).toBeUndefined();
  },
);

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
