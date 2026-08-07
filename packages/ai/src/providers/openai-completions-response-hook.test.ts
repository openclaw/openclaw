import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model, StreamOptions } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const model = {
  id: "gpt-5.5",
  name: "Response hook parity",
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

function installResponse(onRequestAbort?: () => void): void {
  const chunk = {
    id: "chatcmpl-response-hook",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () =>
      vi.fn<typeof fetch>(async (_input, init) => {
        init?.signal?.addEventListener("abort", () => onRequestAbort?.(), { once: true });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-ratelimit-remaining-requests": "42",
            "x-request-id": "req_observable",
          },
        });
      }),
  });
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(
  fixtureModel: Model<"openai-completions">,
  fixtureContext: Context,
  fixtureOptions?: StreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createManagedStream(fixtureModel, fixtureContext, fixtureOptions);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat transport must return its event stream synchronously");
  }
  return stream;
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

describe("managed OpenAI Chat response-hook cancellation", () => {
  it.each(["resolve", "reject"] as const)(
    "aborts a never-settling hook before its late %s without publishing start",
    async (settlement) => {
      const requestAborted = vi.fn();
      installResponse(requestAborted);
      const controller = new AbortController();
      const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
      const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
      let settleHook!: () => void;
      let hookSettled = false;
      const pendingHook = new Promise<void>((resolve, reject) => {
        settleHook = () => {
          hookSettled = true;
          if (settlement === "resolve") {
            resolve();
          } else {
            reject(new Error("late response hook rejection"));
          }
        };
      });
      const onResponse = vi.fn(() => pendingHook);
      const stream = createManagedFixtureStream(model, context, {
        apiKey: "fixture-token",
        signal: controller.signal,
        onResponse,
      });
      const eventTypes: string[] = [];
      const consume = (async () => {
        for await (const event of stream) {
          eventTypes.push(event.type);
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
        const abortReason =
          settlement === "reject"
            ? Object.assign(new Error("caller canceled the provider response"), {
                code: "CALLER_ABORTED",
              })
            : undefined;
        controller.abort(abortReason);
        const result = await Promise.race([
          stream.result(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("response hook cancellation timed out")),
              100,
            );
          }),
        ]);

        expect(result.stopReason).toBe("aborted");
        if (abortReason) {
          expect(result).toMatchObject({
            errorCode: "CALLER_ABORTED",
            errorMessage: "caller canceled the provider response",
          });
        }
        expect(requestAborted).toHaveBeenCalledOnce();
        settleHook();
        await consume;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(eventTypes).toEqual(["error"]);

        for (const [event, listener] of addAbortListener.mock.calls) {
          if (event === "abort") {
            expect(removeAbortListener).toHaveBeenCalledWith("abort", listener);
          }
        }
      } finally {
        clearTimeout(timer);
        if (!hookSettled) {
          settleHook();
        }
        await consume;
      }
    },
  );
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

describe.each([
  { name: "package", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name OpenAI Chat response hook", ({ name, createStream }) => {
  it("awaits response metadata before exposing the first stream event", async () => {
    installResponse();
    const order: string[] = [];
    let continueHook!: () => void;
    const hookCompleted = new Promise<void>((resolve) => {
      continueHook = resolve;
    });
    const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(async () => {
      order.push("response:start");
      await hookCompleted;
      order.push("response:end");
    });

    const stream = createStream(model, context, { apiKey: "fixture-token", onResponse });
    const consume = (async () => {
      for await (const event of stream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["response:start"]);
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "42",
          "x-request-id": "req_observable",
        },
      },
      model,
    );

    continueHook();
    await consume;
    expect((await stream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["response:start", "response:end", "start"]);
  });

  it.each(["throw", "reject"] as const)(
    "surfaces a response hook %s without consuming the provider stream",
    async (failure) => {
      const requestAborted = vi.fn();
      installResponse(requestAborted);
      const onResponse = vi.fn<NonNullable<StreamOptions["onResponse"]>>(() => {
        const error = new Error("after_provider_response hook failed");
        if (failure === "throw") {
          throw error;
        }
        return Promise.reject(error);
      });
      const stream = createStream(model, context, { apiKey: "fixture-token", onResponse });
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();

      expect(onResponse).toHaveBeenCalledOnce();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("after_provider_response hook failed");
      expect(events).not.toContain("start");
      if (name === "managed") {
        expect(requestAborted).toHaveBeenCalledOnce();
      }
    },
  );
});
