import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamOptions } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

const model = {
  id: "gpt-5.5",
  name: "Response hook lifecycle",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;
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

async function eventTypes(stream: AssistantMessageEventStreamLike) {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

type RequestLifecycle = {
  requestAborted: ReturnType<typeof vi.fn>;
  assertListenersRemoved(): void;
};

function installResponse(): RequestLifecycle {
  let addAbortListener: MockInstance<AbortSignal["addEventListener"]> | undefined;
  let removeAbortListener: MockInstance<AbortSignal["removeEventListener"]> | undefined;
  const requestAborted = vi.fn();
  const chunk = {
    id: "chatcmpl-response-hook",
    object: "chat.completion.chunk",
    created: 1,
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

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
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
  configureAiTransportHost(previousHost);
});

describe("OpenAI Chat response hook", () => {
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
    let continueHook!: () => void;
    const hookCompleted = new Promise<void>((resolve) => {
      continueHook = resolve;
    });
    const acceptanceObserver = vi.fn((acceptance: ProviderAcceptance) => {
      order.push(`accepted:${acceptance.kind}`);
    });
    const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(async () => {
      order.push("hook:start");
      await hookCompleted;
      order.push("hook:end");
    });
    const options = withProviderAcceptanceObserver(
      { apiKey: "fixture-token", onResponse },
      acceptanceObserver,
    );
    const stream = streamOpenAICompletions(model, context, options);
    const consume = (async () => {
      for await (const event of stream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["accepted:http_response", "hook:start"]);
    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      ...responseMetadata,
    });
    expect(onResponse).toHaveBeenCalledWith(responseMetadata, model);

    continueHook();
    await consume;
    expect((await stream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 4)).toEqual([
      "accepted:http_response",
      "hook:start",
      "hook:end",
      "start",
    ]);
  });

  it("preserves a hook rejection and closes the unread request", async () => {
    const lifecycle = installResponse();
    const hookError = new Error("after_provider_response hook failed");
    const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(() =>
      Promise.reject(hookError),
    );
    const stream = createStream({ onResponse });
    const events = await eventTypes(stream);
    const result = await stream.result();

    expect(onResponse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "after_provider_response hook failed",
    });
    expect(events).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
    lifecycle.assertListenersRemoved();
  });

  it("preserves an acceptance observer failure and closes the unread request", async () => {
    const lifecycle = installResponse();
    const hookError = new Error("provider acceptance observer failed");
    const acceptanceObserver = vi.fn(() => {
      throw hookError;
    });
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver(
      { apiKey: "fixture-token", onResponse },
      acceptanceObserver,
    );
    const stream = createStream(options);
    const events = await eventTypes(stream);

    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "provider acceptance observer failed",
    });
    expect(acceptanceObserver).toHaveBeenCalledOnce();
    expect(onResponse).not.toHaveBeenCalled();
    expect(events).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
  });

  it("applies the first-event timeout while the hook is pending", async () => {
    const lifecycle = installResponse();
    const onFirstEventTimeout = vi.fn();
    const onResponse = vi.fn(() => new Promise<void>(() => {}));
    const stream = streamOpenAICompletions(model, context, {
      apiKey: "fixture-token",
      firstEventTimeoutMs: 20,
      onFirstEventTimeout,
      onResponse,
    });
    const consume = eventTypes(stream);
    const result = await settleWithin(stream.result());
    const events = await consume;

    expect(onResponse).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /completions HTTP stream opened but did not deliver a first SSE event within 20ms/,
    );
    expect(onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    expect(events).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();
    lifecycle.assertListenersRemoved();
  });

  it("keeps caller cancellation terminal after a late hook rejection", async () => {
    const lifecycle = installResponse();
    const controller = new AbortController();
    let settleHook!: () => void;
    const pendingHook = new Promise<void>((_resolve, reject) => {
      settleHook = () => reject(new Error("late response hook rejection"));
    });
    const onResponse = vi.fn(() => pendingHook);
    const stream = createStream({
      signal: controller.signal,
      onResponse,
    });
    const consume = eventTypes(stream);

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    const abortReason = Object.assign(new Error("caller canceled the provider response"), {
      code: "CALLER_ABORTED",
    });
    controller.abort(abortReason);
    const result = await settleWithin(stream.result());
    const events = await consume;
    expect(result).toMatchObject({
      stopReason: "aborted",
      errorCode: "CALLER_ABORTED",
      errorMessage: "caller canceled the provider response",
    });
    expect(events).toEqual(["error"]);
    expect(lifecycle.requestAborted).toHaveBeenCalledOnce();

    settleHook();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual(["error"]);
    lifecycle.assertListenersRemoved();
  });
});
