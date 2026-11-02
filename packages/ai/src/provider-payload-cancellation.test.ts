import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest, withTestTimeout } from "../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import { streamGoogleInteractions } from "./providers/google-interactions.js";
import { runGoogleGenerateContentLifecycle } from "./providers/google-shared.js";
import { streamMistral } from "./providers/mistral.js";
import { streamOpenAICodexResponses } from "./providers/openai-chatgpt-responses.js";
import { createJwt } from "./providers/openai-chatgpt-responses.test-helpers.js";
import {
  makeOpenAIProviderModel,
  preserveTransportHost,
} from "./providers/openai-provider.test-support.js";
import {
  createResponsesAssistantOutput,
  runResponsesStreamLifecycle,
} from "./providers/openai-responses-shared.js";
import { makeProviderModel } from "./providers/provider-model.test-support.js";
import { createAssistantOutput } from "./transports/assistant-output.js";
import { createOpenAIResponsesTransportStreamFn } from "./transports/openai-responses-client.js";
import type { Context, StreamOptions } from "./types.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";

preserveTransportHost();

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

const interactionsModel = makeProviderModel("google-interactions", "google", "gemini-3-flash", {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
});
const generateContentModel = makeProviderModel("google-generative-ai", "google", "gemini-3-pro", {
  baseUrl: "https://generativelanguage.googleapis.com",
});
const mistralModel = makeProviderModel("mistral-conversations", "mistral", "mistral-large", {
  baseUrl: "https://api.mistral.ai/v1",
});
const responsesModel = makeOpenAIProviderModel("openai-responses");
const codexModel = makeOpenAIProviderModel("openai-chatgpt-responses", {
  provider: "openai-codex",
  id: "gpt-5.5-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
});

function neverYielding<T>(): AsyncIterable<T> {
  const pending = new Promise<IteratorResult<T>>(() => {});
  return { [Symbol.asyncIterator]: () => ({ next: () => pending }) };
}

function encodeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type StreamHandle = { result(): Promise<unknown> } | Promise<{ result(): Promise<unknown> }>;

type CancelCase = {
  name: string;
  stream: (options: StreamOptions) => StreamHandle;
};

const cases: CancelCase[] = [
  {
    name: "google interactions",
    stream: (options) =>
      streamGoogleInteractions(interactionsModel, context, { apiKey: "fixture", ...options }),
  },
  {
    name: "google generate content",
    stream: (options) => {
      const stream = new AssistantMessageEventStream();
      void runGoogleGenerateContentLifecycle({
        stream,
        model: generateContentModel,
        output: createAssistantOutput(generateContentModel),
        options,
        createClient: () => ({
          models: {
            generateContentStream: async () => {
              throw new Error("payload hook cancellation reached the provider client");
            },
          },
        }),
        buildParams: () => ({ model: generateContentModel.id, contents: [] }) as never,
        nextToolCallId: () => "call-1",
      });
      return stream;
    },
  },
  {
    name: "mistral conversations",
    stream: (options) => streamMistral(mistralModel, context, { apiKey: "fixture", ...options }),
  },
  {
    name: "openai codex responses",
    stream: (options) =>
      streamOpenAICodexResponses(codexModel, context, {
        apiKey: createJwt(),
        transport: "sse",
        ...options,
      }),
  },
  {
    name: "openai responses lifecycle",
    stream: (options) => {
      const stream = new AssistantMessageEventStream();
      void runResponsesStreamLifecycle({
        stream,
        model: responsesModel,
        output: createResponsesAssistantOutput(responsesModel),
        context,
        options,
        createClient: () => ({
          responses: {
            create: () => ({
              withResponse: async () => ({
                data: neverYielding(),
                response: encodeResponse({ id: "resp-1" }),
              }),
            }),
          },
        }),
        buildParams: () => ({ model: responsesModel.id, input: [] }) as never,
      });
      return stream;
    },
  },
  {
    name: "openai responses transport",
    stream: (options) =>
      createOpenAIResponsesTransportStreamFn()(responsesModel, context, {
        apiKey: "fixture",
        transport: "sse",
        ...options,
      }),
  },
];

describe.each(cases)("$name payload hook", ({ name, stream }) => {
  it(
    "settles cancellation before the unfinished hook returns",
    { timeout: 15_000 },
    async ({ signal }) => {
      const controller = new AbortController();
      const entered = createDeferred();
      const hook = createDeferred();
      const observed: Promise<unknown>[] = [];
      let hookFinished = false;
      const fetchStub = vi.fn(async () =>
        encodeResponse({ error: { message: "unexpected" } }, 500),
      );
      configureAiTransportHost({
        ...getAiTransportHost(),
        buildModelFetch: () => fetchStub,
        observePendingProviderWork: (pending) => observed.push(pending),
      });
      const options = {
        signal: controller.signal,
        onPayload: async () => {
          entered.resolve();
          try {
            await hook.promise;
          } finally {
            hookFinished = true;
          }
          return undefined;
        },
      } as StreamOptions;

      const result = await stream(options);
      try {
        await withinTest(entered.promise, signal);
        controller.abort(
          Object.assign(new Error("payload cancelled"), { code: "caller_cancelled" }),
        );
        const settled = await withTestTimeout(
          result.result(),
          1_000,
          `${name} did not settle cancellation while the payload hook was pending`,
        );
        expect(settled).toMatchObject({ stopReason: "aborted" });
        expect(hookFinished).toBe(false);
        expect(observed).not.toHaveLength(0);
        expect(fetchStub).not.toHaveBeenCalled();

        hook.resolve();
        await Promise.allSettled(observed);
        expect(hookFinished).toBe(true);
        expect(await result.result()).toBe(settled);
        expect(fetchStub).not.toHaveBeenCalled();
      } finally {
        hook.resolve();
        await Promise.allSettled([...observed, result.result()]);
      }
    },
  );
});
