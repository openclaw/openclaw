import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  openAICtorMock,
  azureOpenAICtorMock,
  responsesCreateMock,
  completionsCreateMock,
  buildGuardedModelFetchMock,
  guardedFetchMock,
} = vi.hoisted(() => ({
  openAICtorMock: vi.fn(),
  azureOpenAICtorMock: vi.fn(),
  responsesCreateMock: vi.fn(),
  completionsCreateMock: vi.fn(),
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: responsesCreateMock };
    chat = { completions: { create: completionsCreateMock } };

    constructor(options?: unknown) {
      openAICtorMock(options);
    }
  },
  AzureOpenAI: class MockAzureOpenAI {
    responses = { create: responsesCreateMock };
    chat = { completions: { create: completionsCreateMock } };

    constructor(options?: unknown) {
      azureOpenAICtorMock(options);
    }
  },
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createOpenAIResponsesTransportStreamFn: typeof import("./openai-transport-stream.js").createOpenAIResponsesTransportStreamFn;
let createOpenAICompletionsTransportStreamFn: typeof import("./openai-transport-stream.js").createOpenAICompletionsTransportStreamFn;

describe("openai transport stream upstream request ids", () => {
  beforeAll(async () => {
    ({ createOpenAIResponsesTransportStreamFn, createOpenAICompletionsTransportStreamFn } =
      await import("./openai-transport-stream.js"));
  });

  beforeEach(() => {
    openAICtorMock.mockReset();
    azureOpenAICtorMock.mockReset();
    responsesCreateMock.mockReset();
    completionsCreateMock.mockReset();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
  });

  it("captures response header request ids for responses streams", async () => {
    const streamedEvents = (async function* () {
      yield {
        type: "response.created",
        response: { id: "resp_1" },
      };
      yield {
        type: "response.output_item.added",
        item: { type: "message", id: "msg_1" },
      };
      yield {
        type: "response.output_text.delta",
        delta: "hello",
      };
      yield {
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_1",
          content: [{ type: "output_text", text: "hello" }],
        },
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
          },
        },
      };
    })();
    responsesCreateMock.mockReturnValueOnce({
      withResponse: async () => ({
        data: streamedEvents,
        response: new Response(null, {
          headers: {
            "x-request-id": "req_header_123",
          },
        }),
        request_id: "req_fallback_456",
      }),
    });

    const streamFn = createOpenAIResponsesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } as Model<"openai-responses">,
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-openai-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect((result as { upstreamRequestId?: string }).upstreamRequestId).toBe("req_header_123");
    expect(openAICtorMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to bare stream metadata when withResponse is unavailable", async () => {
    const streamedChunks = Object.assign(
      (async function* () {
        yield {
          id: "chatcmpl_1",
          choices: [
            {
              delta: { content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        };
      })(),
      {
        request_id: "req_stream_789",
      },
    );
    completionsCreateMock.mockReturnValueOnce(streamedChunks);

    const streamFn = createOpenAICompletionsTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          api: "openai-completions",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } as Model<"openai-completions">,
        {
          messages: [{ role: "user", content: "hello" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-openai-api",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect((result as { upstreamRequestId?: string }).upstreamRequestId).toBe("req_stream_789");
    expect(openAICtorMock).toHaveBeenCalledTimes(1);
  });
});
