import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import { createDeferred, withinTest, nextEventLoopTurn } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessageEventStreamLike, Context, StreamOptions } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import { collectEventTypes } from "./openai-stream-cases.test-support.js";
import {
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

const model = createModel<"openai-completions">({
  id: "gpt-5.5",
  api: "openai-completions",
  reasoning: false,
});
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;
const responseMetadata = {
  status: 202,
  headers: {
    "content-type": "text/event-stream",
    "x-ratelimit-remaining-requests": "42",
    "x-request-id": "req_observable",
  },
};

function installResponse() {
  let addAbortListener: MockInstance<AbortSignal["addEventListener"]> | undefined;
  let removeAbortListener: MockInstance<AbortSignal["removeEventListener"]> | undefined;
  const requestAborted = vi.fn();
  const chunk = {
    id: "chatcmpl-response-hook",
    object: "chat.completion.chunk",
    model: model.id,
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async (_input, init) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", requestAborted, { once: true });
        addAbortListener = vi.spyOn(signal, "addEventListener");
        removeAbortListener = vi.spyOn(signal, "removeEventListener");
      }
      return new Response(body, responseMetadata);
    },
  });
  return {
    requestAborted,
    assertListenersRemoved() {
      for (const [event, listener] of addAbortListener?.mock.calls ?? []) {
        if (event === "abort") {
          expect(removeAbortListener).toHaveBeenCalledWith("abort", listener);
        }
      }
    },
  };
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createStream(options: StreamOptions): AssistantMessageEventStreamLike {
  const stream = createManagedStream(model, context, { apiKey: "fixture-token", ...options });
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat transport must return its event stream synchronously");
  }
  return stream;
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

it("reports a rejected response before its body is consumed without retrying", async () => {
  const response = Response.json({ error: { message: "overloaded" } }, { status: 503 });
  const readBody = vi.spyOn(response, "text");
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  configureAiTransportHost({ buildModelFetch: () => fetchMock });
  const bodyReadsDuringHook: number[] = [];
  const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(() => {
    bodyReadsDuringHook.push(readBody.mock.calls.length);
  });

  const result = await createStream({ onResponse }).result();

  expect(result.stopReason).toBe("error");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(onResponse.mock.calls.map(([metadata]) => metadata.status)).toEqual([503]);
  expect(bodyReadsDuringHook).toEqual([0]);
});

it("awaits response metadata before exposing the first stream event", async () => {
  installResponse();
  const order: string[] = [];
  const hookCompleted = createDeferred();
  const acceptanceObserver = vi.fn((acceptance: ProviderAcceptance) => {
    order.push(`accepted:${acceptance.kind}`);
  });
  const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(async () => {
    order.push("hook:start");
    await hookCompleted.promise;
    order.push("hook:end");
  });
  const options = withProviderAcceptanceObserver(
    { apiKey: "fixture-token", onResponse },
    acceptanceObserver,
  );
  const stream = streamOpenAICompletions(model, context, options);
  const consume = collectEventTypes(stream, order);

  await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
  expect(order).toEqual(["accepted:http_response", "hook:start"]);
  expect(acceptanceObserver).toHaveBeenCalledWith({
    kind: "http_response",
    ...responseMetadata,
  });
  expect(onResponse).toHaveBeenCalledWith(responseMetadata, model);

  hookCompleted.resolve();
  await consume;
  expect((await stream.result()).stopReason).toBe("stop");
  expect(order.slice(0, 4)).toEqual(["accepted:http_response", "hook:start", "hook:end", "start"]);
});

it.each(["response hook", "acceptance observer"])(
  "preserves %s failure and closes the unread request",
  async (phase) => {
    const lifecycle = installResponse();
    const hookError = new Error(`${phase} failed`);
    const acceptanceObserver = vi.fn(() => {
      if (phase === "acceptance observer") {
        throw hookError;
      }
    });
    const onResponse = vi.fn(() => Promise.reject(hookError));
    const options = withProviderAcceptanceObserver(
      { apiKey: "fixture-token", onResponse },
      acceptanceObserver,
    );
    const stream = createStream(options);
    const events = await collectEventTypes(stream);

    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: hookError.message,
    });
    expect(acceptanceObserver).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledTimes(phase === "response hook" ? 1 : 0);
    expect(events).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
    lifecycle.assertListenersRemoved();
  },
);

it("applies the first-event timeout while the hook is pending", async ({ signal }) => {
  const lifecycle = installResponse();
  const onFirstEventTimeout = vi.fn();
  const onResponse = vi.fn(() => new Promise<void>(() => {}));
  const stream = streamOpenAICompletions(model, context, {
    apiKey: "fixture-token",
    firstEventTimeoutMs: 20,
    onFirstEventTimeout,
    onResponse,
  });
  const consume = collectEventTypes(stream);
  const result = await withinTest(stream.result(), signal);
  const events = await consume;

  expect(onResponse).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringMatching(
      /completions HTTP stream opened but did not deliver a first SSE event within 20ms/,
    ),
  });
  expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
  expect(events).toEqual(["error"]);
  expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
  lifecycle.assertListenersRemoved();
});

it("keeps caller cancellation terminal after a late hook rejection", async ({ signal }) => {
  const lifecycle = installResponse();
  const controller = new AbortController();
  const pendingHook = createDeferred();
  const onResponse = vi.fn(() => pendingHook.promise);
  const stream = createStream({
    signal: controller.signal,
    onResponse,
  });
  const consume = collectEventTypes(stream);

  await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
  const abortReason = Object.assign(new Error("caller canceled the provider response"), {
    code: "CALLER_ABORTED",
  });
  controller.abort(abortReason);
  const result = await withinTest(stream.result(), signal);
  const events = await consume;
  expect(result).toMatchObject({
    stopReason: "aborted",
    errorCode: "CALLER_ABORTED",
    errorMessage: "caller canceled the provider response",
  });
  expect(events).toEqual(["error"]);
  expect(lifecycle.requestAborted).toHaveBeenCalledOnce();

  pendingHook.reject(new Error("late response hook rejection"));
  await nextEventLoopTurn();
  expect(events).toEqual(["error"]);
  lifecycle.assertListenersRemoved();
});
