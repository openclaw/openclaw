import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { streamAzureOpenAIResponses } from "../providers/azure-openai-responses.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamFn } from "../types.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { responsesLoopbackModel } from "./openai-responses-loopback.test-support.js";
import { message } from "./openai-responses-stream-parity.test-helpers.js";

const openAIModel = {
  ...responsesLoopbackModel,
  id: "gpt-5.6-luna",
  name: "Responses hook lifecycle",
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-responses">;

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

const encodeJwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const chatGptToken = [
  encodeJwtPart({ alg: "none", typ: "JWT" }),
  encodeJwtPart({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-response-hook" } }),
  "signature",
].join(".");
const responseMetadata = {
  status: 202,
  headers: {
    "content-type": "text/event-stream",
    "x-ratelimit-remaining-requests": "42",
    "x-request-id": "req_observable",
  },
};

function completedResponse(init?: ResponseInit, eventHeaders?: Record<string, string>): Response {
  const response = {
    id: "resp_response_hook",
    status: "completed",
    model: openAIModel.id,
    ...(eventHeaders ? { headers: eventHeaders } : {}),
    output: [message("msg_response_hook", "hello")],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.completed", response },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    ...responseMetadata,
    ...init,
  });
}

function trackedFetch(responseFactory: () => Response) {
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

function installFixtureResponse(native = false, responseFactory = completedResponse) {
  const tracked = trackedFetch(responseFactory);
  if (native) {
    vi.stubGlobal("fetch", tracked.fetch);
  } else {
    configureAiTransportHost({ buildModelFetch: () => tracked.fetch });
  }
  return tracked.lifecycle;
}

type FixtureStream<T extends Model["api"]> = (
  model: Model<T>,
  context: Context,
  options?: BaseOpenAIStreamOptions,
) => ReturnType<StreamFn>;

function createManagedFixtureStream<T extends Model["api"]>(
  createStream: FixtureStream<T>,
  model: Model<T>,
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

function fixture<T extends Model["api"]>(
  name: string,
  model: Model<T>,
  createStream: FixtureStream<T>,
  defaults: Parameters<typeof streamOpenAICodexResponses>[2] = {},
) {
  return {
    name,
    model,
    installResponse: () => installFixtureResponse(model.api === "openai-chatgpt-responses"),
    createStream: (options?: BaseOpenAIStreamOptions) =>
      createManagedFixtureStream(createStream, model, { ...defaults, ...options }),
  };
}

async function collectEventTypes(stream: AssistantMessageEventStreamLike, into: string[]) {
  for await (const event of stream) {
    into.push(event.type);
  }
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
  chatgpt: fixture("native ChatGPT SSE", chatGptModel, streamOpenAICodexResponses, {
    apiKey: chatGptToken,
    transport: "sse",
  }),
};

const settleWithin = <T>(promise: Promise<T>) =>
  withTestTimeout(promise, 500, "response hook lifecycle timed out");

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

it("preserves sampling on the managed Azure Responses route", async () => {
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

it("preserves the turn encoding on the final OpenAI SDK request", async () => {
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

it.each([fixtures.azure, fixtures.chatgpt])(
  "$name awaits response metadata before exposing the first stream event",
  async ({ createStream, installResponse, model }) => {
    installResponse();
    const order: string[] = [];
    const hookCompleted = createDeferred<void>();
    const onResponse = vi.fn(async () => {
      order.push("hook:start");
      await hookCompleted.promise;
      order.push("hook:end");
    });
    const stream = createStream({ onResponse });
    const consume = collectEventTypes(stream, order);

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["hook:start"]);
    expect(onResponse).toHaveBeenCalledWith(responseMetadata, model);

    hookCompleted.resolve();
    await consume;
    expect((await stream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
  },
);

it.each(["shared success", "native ChatGPT non-success"])(
  "%s applies the first-event timeout while the hook is pending",
  async (route) => {
    const shared = route === "shared success";
    const lifecycle = shared ? fixtures.shared.installResponse() : undefined;
    const bodyCancelled = vi.fn();
    if (!shared) {
      const body = new ReadableStream<Uint8Array>({ pull() {}, cancel: bodyCancelled });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 })),
      );
    }
    const onFirstEventTimeout = vi.fn();
    const onResponse = vi.fn(() => new Promise<void>(() => {}));
    const stream = (shared ? fixtures.shared : fixtures.chatgpt).createStream({
      firstEventTimeoutMs: 20,
      onFirstEventTimeout,
      onResponse,
    });
    const eventTypes: string[] = [];
    const consume = collectEventTypes(stream, eventTypes);
    const result = await settleWithin(stream.result());
    await consume;

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringMatching(
        /responses HTTP stream opened but did not deliver a first SSE event within 20ms/,
      ),
    });
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(lifecycle?.requestAborted ?? bodyCancelled).toHaveBeenCalledOnce();
    if (lifecycle) {
      expect(onResponse).toHaveBeenCalledOnce();
      expect(eventTypes).toEqual(["error"]);
      lifecycle.assertListenersRemoved();
    }
  },
);

it.each([
  { ...fixtures.openai, settlement: "resolve" },
  { ...fixtures.openai, settlement: "reject" },
  { ...fixtures.chatgpt, settlement: "resolve" },
  { ...fixtures.chatgpt, settlement: "reject" },
])(
  "$name keeps caller cancellation terminal after a late hook $settlement",
  async ({ createStream, installResponse, settlement }) => {
    const lifecycle = installResponse();
    const controller = new AbortController();
    const pendingHook = createDeferred<void>();
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
    await immediate();
    expect(eventTypes).toEqual(["error"]);
    lifecycle.assertListenersRemoved();
  },
);

it("preserves the concrete model reported by managed SSE event headers", async () => {
  const responseModel = "gpt-5.6-luna-2026-08-02";
  installFixtureResponse(false, () =>
    completedResponse(undefined, { "x-openai-model": responseModel }),
  );

  const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();

  expect(result.responseModel).toBe(responseModel);
});

it.each(["SSE event", "repeated HTTP header"])(
  "fails closed on conflicting model attestations in a %s",
  async (source) => {
    const headers = new Headers({ "openai-model": "gpt-5.6-sol" });
    headers.append("openai-model", "gpt-5.6-terra-2026-08-01");
    installFixtureResponse(false, () =>
      source === "SSE event"
        ? completedResponse(undefined, {
            "openai-model": "gpt-5.6-sol",
            "x-openai-model": "gpt-5.6-terra-2026-08-01",
          })
        : completedResponse({ headers }),
    );

    const result = await createManagedFixtureStream(managedOpenAIStream, chatGptModel).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Conflicting OpenAI response model attestations",
    });
    expect(result.responseModel).toBeUndefined();
  },
);

it.each(Object.values(fixtures))(
  "$name reports rejection before body consumption while another request completes",
  async ({ createStream }) => {
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
  },
);
