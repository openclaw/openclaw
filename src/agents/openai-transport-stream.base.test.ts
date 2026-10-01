import { getAiTransportHost } from "@openclaw/ai";
import {
  buildTransportAwareSimpleStreamFn,
  createAzureOpenAIResponsesTransportStreamFn,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { assert, describe, expect, it, vi } from "vitest";
import { logResponsesFailedNoDetails } from "../../packages/ai/src/transports/openai-responses-debug.js";
import {
  resolveAzureOpenAIApiVersion,
  type OpenAIResponsesOutput,
  makeResponsesModel,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  neverYieldsStream,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

describe("openai transport stream", () => {
  it("keeps bounded redacted diagnostics UTF-16 well-formed", () => {
    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "full-redacted";
    try {
      const payload = testing.summarizeResponsesPayload({ input: `${"x".repeat(7_989)}🚀tail` });
      const event = testing.stringifyRedactedEvent(`${"x".repeat(1_998)}🚀tail`);

      expect(payload).toContain(`payload={"input":"${"x".repeat(7_989)}…<truncated>`);
      expect(event).toContain(`${"x".repeat(1_998)}…<truncated>`);
      expect(payload).not.toContain("\uD83D");
      expect(event).not.toContain("\uD83D");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });

  it("fails Azure Responses streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
    try {
      const model = createAzureResponsesModel();
      const abortFirstEventStream = vi.fn();
      const onFirstEventTimeout = vi.fn();
      const resultPromise = testing.processResponsesStream(
        neverYieldsStream(),
        createResponsesAssistantOutput(model),
        { push: vi.fn() },
        model,
        { firstEventTimeoutMs: 5, abortFirstEventStream, onFirstEventTimeout },
      );
      const rejection = expect(resultPromise).rejects.toThrow(
        /did not deliver a first SSE event within 5ms after streaming headers/,
      );

      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(abortFirstEventStream).toHaveBeenCalledTimes(1);
      expect(abortFirstEventStream.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(abortFirstEventStream.mock.calls[0]?.[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes detail-less Responses failures without leaking request ids", async () => {
    // Observation should preserve hashes/metadata shape while dropping raw request ids.
    const model = createAzureResponsesModel();
    const event = {
      type: "response.failed",
      response: {
        id: "resp_failed_123",
        status: "failed",
        model: "gpt-5.4-pro",
        metadata: {
          litellm_request_id: "litellm_req_plaintext_123",
          api_key: "sk-observation-secret",
        },
        provider_request_id: "provider_req_plaintext_456",
        status_details: {
          provider_request_id: "provider_req_nested_789",
        },
        provider_error: {
          request_id: "provider_error_req_nested_012",
          headers: {
            "x-request-id": ["header_req_plaintext_345", "header_req_plaintext_678"],
          },
        },
      },
    };

    const observation = testing.normalizeResponsesFailedEvent(event, model).observation;
    assert(observation);

    expect(observation.providerRuntimeFailureKind).toBe("no_error_details");
    expect(observation.responseId).toBe("resp_failed_123");
    expect(observation.responseStatus).toBe("failed");
    expect(observation.responseModel).toBe("gpt-5.4-pro");
    expect(observation.metadataKeys).toEqual(["api_key", "litellm_request_id"]);
    expect(observation.requestIdHashes).toHaveLength(6);
    expect(observation.requestIdHashes.join(",")).toContain("sha256:");
    const logWarn = vi.spyOn(getAiTransportHost(), "logWarn").mockImplementation(() => {});
    try {
      logResponsesFailedNoDetails(observation);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn.mock.calls[0]?.[1]).toContain("responseId=resp_failed_123");
      expect(logWarn.mock.calls[0]?.[1]).toContain("requestIds=");
    } finally {
      logWarn.mockRestore();
    }
    expect(JSON.stringify(observation)).not.toContain("litellm_req_plaintext_123");
    expect(JSON.stringify(observation)).not.toContain("provider_req_plaintext_456");
    expect(JSON.stringify(observation)).not.toContain("provider_req_nested_789");
    expect(JSON.stringify(observation)).not.toContain("provider_error_req_nested_012");
    expect(JSON.stringify(observation)).not.toContain("header_req_plaintext_345");
    expect(JSON.stringify(observation)).not.toContain("header_req_plaintext_678");
    expect(JSON.stringify(observation)).not.toContain("sk-observation-secret");
  });

  it("treats empty Responses error objects as detail-less failures", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await expect(
      testing.processResponsesStream(
        streamChunks([
          {
            type: "response.failed",
            response: {
              id: "resp_failed_empty_error",
              status: "failed",
              model: "gpt-5.4-pro",
              error: { code: null, message: null },
              provider_request_id: "provider_req_empty_error",
            },
          },
        ]),
        output,
        { push: vi.fn() },
        model,
      ),
    ).rejects.toThrow("Unknown error (no error details in response)");

    expect(output.responseId).toBe("resp_failed_empty_error");
  });

  it("tags Responses encrypted reasoning with replay provenance while streaming", async () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    const output: OpenAIResponsesOutput = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createZeroUsageFixture(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    await testing.processResponsesStream(
      streamChunks([
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_123",
            encrypted_content: "ciphertext",
            summary: [{ type: "summary_text", text: "Need a tool." }],
          },
        },
        { type: "response.completed", response: { id: "resp_123", status: "completed" } },
      ]),
      output,
      { push: vi.fn() },
      model,
      {
        reasoningReplayMetadata: testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
          authProfileId: "openai:oauth",
          sessionId: "session-123",
        }),
      },
    );

    const expectedReplayMetadata = testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
      authProfileId: "openai:oauth",
      sessionId: "session-123",
    });
    const thinkingBlock = output.content[0] as {
      thinkingSignature?: string;
      openclawReasoningReplay?: unknown;
    };
    const replayItem = JSON.parse(thinkingBlock.thinkingSignature ?? "{}") as Record<
      string,
      unknown
    >;
    expect(replayItem).toMatchObject({
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "ciphertext",
    });
    expect(replayItem).not.toHaveProperty("__openclaw_replay");
    expect(thinkingBlock.openclawReasoningReplay).toEqual(expectedReplayMetadata);
  });

  it("collapses cumulative message snapshots in completed-response backfill (#91959)", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-backfill-snapshots",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer" }],
              },
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer is 42." }],
              },
              {
                type: "message",
                id: "msg_3",
                role: "assistant",
                content: [{ type: "output_text", text: "The answer" }],
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // msg_2 strictly extends msg_1 and collapses into it; msg_3 shrinks back
    // and is an independently identified message, so it stays a real block.
    expect(output.content).toEqual([
      {
        type: "text",
        text: "The answer is 42.",
        textSignature: '{"v":1,"id":"msg_2"}',
      },
      {
        type: "text",
        text: "The answer",
        textSignature: '{"v":1,"id":"msg_3"}',
      },
    ]);
  });

  it("keeps backfill message items separated by a reasoning item as distinct blocks", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.completed",
          response: {
            id: "resp-backfill-reasoning-boundary",
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "Step one." }],
              },
              { type: "reasoning", id: "rs_1", summary: [] },
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                content: [{ type: "output_text", text: "Step one. Step two." }],
              },
            ],
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // A reasoning item is a real boundary even in backfill: msg_2 must not
    // collapse into msg_1 despite being a strict extension (mirrors streaming).
    expect(output.content).toEqual([
      { type: "text", text: "Step one.", textSignature: '{"v":1,"id":"msg_1"}' },
      { type: "text", text: "Step one. Step two.", textSignature: '{"v":1,"id":"msg_2"}' },
    ]);
  });

  it("redacts full model payload debug summaries", () => {
    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "full-redacted";
    try {
      const apiKey = "test-api-key";
      const summary = testing.summarizeResponsesPayload({
        model: "gpt-5.5",
        stream: true,
        input: [],
        tools: [{ type: "function", name: "exec" }],
        apiKey,
      });
      expect(summary).toContain("payload=");
      expect(summary).toContain('"apiKey":"***"');
      expect(summary).not.toContain(apiKey);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });

  it("adds OpenClaw attribution to native OpenAI transport headers and protects it from provider overrides", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
          "X-Provider": "model",
        },
      }),
      { systemPrompt: "", messages: [] } as never,
      {
        originator: "openclaw",
        "User-Agent": "openclaw",
        "X-Caller": "request",
      },
    );

    expectRecordFields(headers, {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
      "X-Provider": "model",
      "X-Caller": "request",
    });
  });

  it("adds OpenClaw attribution to native OpenAI Codex transport headers", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const headers = testing.buildOpenAIClientHeaders(
      makeResponsesModel({
        id: "gpt-5.4-codex",
        name: "GPT-5.4 Codex",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      }),
      { systemPrompt: "", messages: [] } as never,
    );

    expectRecordFields(headers, {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(headers.Accept).toBeUndefined();
    expect(headers.accept).toBeUndefined();
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expectRecordFields(prepared, {
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot OpenAI-family models on the shared transport seam", () => {
    const model = attachModelProviderRequestTransport(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/v1",
        input: ["text", "image"],
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expectRecordFields(prepareTransportAwareSimpleModel(model), {
      api: "openclaw-openai-responses-transport",
      provider: "github-copilot",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot Claude models on the shared Anthropic transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expectRecordFields(prepareTransportAwareSimpleModel(model), {
      api: "openclaw-anthropic-messages-transport",
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("uses a valid Azure API version default when the environment is unset", () => {
    expect(resolveAzureOpenAIApiVersion({})).toBe("preview");
    expect(resolveAzureOpenAIApiVersion({ AZURE_OPENAI_API_VERSION: "2025-01-01-preview" })).toBe(
      "2025-01-01-preview",
    );
  });

  it.each([
    {
      baseUrl: "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      azureApiVersion: null,
    },
    { baseUrl: "https://example.openai.azure.com", azureApiVersion: "preview" },
  ])(
    "preserves Azure routing and prepared headers for $baseUrl",
    async ({ baseUrl, azureApiVersion }) => {
      const previousApiVersion = process.env.AZURE_OPENAI_API_VERSION;
      const model = {
        ...createAzureResponsesModel(),
        baseUrl,
      };
      const requests: Request[] = [];
      const fetchOwner = vi
        .spyOn(getAiTransportHost(), "buildModelFetch")
        .mockReturnValue(async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { id: "resp_fixture", status: "completed", output: [] },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        });
      process.env.AZURE_OPENAI_API_VERSION = "preview";
      try {
        const stream = await createAzureOpenAIResponsesTransportStreamFn()(
          model,
          {
            messages: [{ role: "user", content: "hello", timestamp: 1 }],
          },
          { apiKey: "test-key", headers: { session_id: "prepared-affinity" } },
        );
        const result = await stream.result();
        expect(result.stopReason).toBe("stop");
        expect(requests).toHaveLength(1);
        const request = requests[0];
        assert(request);
        const url = new URL(request.url);
        expect(url.origin + url.pathname).toBe(`${baseUrl}/responses`);
        expect(url.searchParams.get("api-version")).toBe(azureApiVersion);
        expect(request.headers.get(azureApiVersion ? "api-key" : "authorization")).toBe(
          azureApiVersion ? "test-key" : "Bearer test-key",
        );
        expect(request.headers.get("session_id")).toBe("prepared-affinity");
      } finally {
        fetchOwner.mockRestore();
        if (previousApiVersion === undefined) {
          delete process.env.AZURE_OPENAI_API_VERSION;
        } else {
          process.env.AZURE_OPENAI_API_VERSION = previousApiVersion;
        }
      }
    },
  );

  it("does not replay terminal text that already streamed", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_streamed" },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_streamed",
          delta: "STREAMED_HALF_SENTENCE",
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp-streamed",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            // The terminal payload repeats what the stream already delivered; replaying it
            // would persist the same text twice in the assistant turn.
            output: [
              {
                type: "message",
                id: "msg_streamed",
                role: "assistant",
                content: [{ type: "text", text: "STREAMED_HALF_SENTENCE" }],
              },
            ],
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    expect(output.content).toMatchObject([{ type: "text", text: "STREAMED_HALF_SENTENCE" }]);
    expect(output.stopReason).toBe("length");
  });

  it("keeps terminal-only text out of turns that stop for a non-length reason", async () => {
    const model = createAzureResponsesModel();
    const output = createResponsesAssistantOutput(model);

    await testing.processResponsesStream(
      streamChunks([
        {
          type: "response.incomplete",
          response: {
            id: "resp-filtered",
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            output: [
              {
                type: "message",
                id: "msg_filtered",
                role: "assistant",
                content: [{ type: "text", text: "FILTERED_PARTIAL" }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
          },
        },
      ]),
      output,
      { push: vi.fn() },
      model,
    );

    // A filtered turn is surfaced as an error, so its partial text is not a recoverable answer.
    expect(output.content).toEqual([]);
    expect(output.stopReason).toBe("error");
  });
});
