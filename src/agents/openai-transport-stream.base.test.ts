import { getAiTransportHost } from "@openclaw/ai";
import { createAzureOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createAssistantOutput } from "../../packages/ai/src/transports/assistant-output.js";
import {
  observeResponsesTransportFailure,
  ResponsesStreamFailure,
} from "../../packages/ai/src/transports/openai-responses-debug.js";
import {
  resolveAzureOpenAIApiVersion,
  makeResponsesModel,
  createResponsesAssistantOutput,
  createAzureResponsesModel,
  neverYieldsStream,
  streamChunks,
  expectRecordFields,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

async function streamOutput(
  chunks: readonly unknown[],
  model: Parameters<typeof testing.processResponsesStream>[3] = createAzureResponsesModel(),
  options?: Parameters<typeof testing.processResponsesStream>[4],
) {
  const output = createAssistantOutput(model);
  await testing.processResponsesStream(
    streamChunks(chunks),
    output,
    { push: vi.fn() },
    model,
    options,
  );
  return output;
}

function message(id: string, text: string, type = "output_text") {
  return { type: "message", id, role: "assistant", content: [{ type, text }] };
}

const completed = (output: readonly unknown[] = []) => ({
  type: "response.completed",
  response: { id: "resp_fixture", status: "completed", output },
});
const textBlock = (id: string, text: string) => ({
  type: "text",
  text,
  textSignature: JSON.stringify({ v: 1, id }),
});
const itemEvent = (phase: "added" | "done", item: object, output_index?: number) => ({
  type: `response.output_item.${phase}`,
  item,
  output_index,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("openai transport stream", () => {
  it("fails Azure Responses streams when headers arrive but no first event follows", async () => {
    vi.useFakeTimers();
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
  });

  it("observes detail-less Responses failures without leaking request ids", async () => {
    const secrets = Array.from({ length: 7 }, (_, index) => `private-identifier-${index}`);
    const event = {
      type: "response.failed",
      response: {
        id: "resp_failed_123",
        status: "failed",
        model: "gpt-5.4-pro",
        metadata: {
          litellm_request_id: secrets[0],
          api_key: secrets[6],
        },
        provider_request_id: secrets[1],
        status_details: { provider_request_id: secrets[2] },
        provider_error: {
          request_id: secrets[3],
          headers: { "x-request-id": secrets.slice(4, 6) },
        },
      },
    };

    const model = createAzureResponsesModel();
    const failure = testing.normalizeResponsesFailedEvent(event, model);
    const observation = failure.observation;
    assert(observation);

    expect(observation).toMatchObject({
      providerRuntimeFailureKind: "no_error_details",
      responseId: "resp_failed_123",
      responseStatus: "failed",
      responseModel: "gpt-5.4-pro",
      metadataKeys: ["api_key", "litellm_request_id"],
    });
    expect(observation.requestIdHashes).toHaveLength(6);
    expect(observation.requestIdHashes.join(",")).toContain("sha256:");
    const logWarn = vi.spyOn(getAiTransportHost(), "logWarn").mockImplementation(() => {});
    observeResponsesTransportFailure({
      error: new ResponsesStreamFailure(failure, event.response),
      model,
      output: createResponsesAssistantOutput(model),
    });
    expect(logWarn).toHaveBeenCalledOnce();
    expect(logWarn.mock.calls[0]?.[1]).toContain("responseId=resp_failed_123");
    expect(logWarn.mock.calls[0]?.[1]).toContain("requestIds=");
    for (const secret of secrets) {
      expect(JSON.stringify(observation)).not.toContain(secret);
      expect(JSON.stringify(logWarn.mock.calls)).not.toContain(secret);
    }
  });

  it("tags Responses encrypted reasoning with replay provenance while streaming", async () => {
    const model = makeResponsesModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    const replayMetadata = testing.buildOpenAIResponsesReasoningReplayMetadata(model, {
      authProfileId: "openai:oauth",
      sessionId: "session-123",
    });
    const reasoning = {
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "ciphertext",
      summary: [{ type: "summary_text", text: "Need a tool." }],
    };
    const output = await streamOutput(
      [itemEvent("added", { type: "reasoning" }), itemEvent("done", reasoning), completed()],
      model,
      { reasoningReplayMetadata: replayMetadata },
    );

    const thinkingBlock = output.content[0] as {
      thinkingSignature?: string;
      openclawReasoningReplay?: unknown;
    };
    const replayItem: unknown = JSON.parse(thinkingBlock.thinkingSignature ?? "{}");
    expect(replayItem).toMatchObject({
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "ciphertext",
    });
    expect(replayItem).not.toHaveProperty("__openclaw_replay");
    expect(thinkingBlock.openclawReasoningReplay).toEqual(replayMetadata);
  });

  it.each([
    [
      "collapses extensions but retains shrinking snapshots (#91959)",
      [
        message("msg_1", "The answer"),
        message("msg_2", "The answer is 42."),
        message("msg_3", "The answer"),
      ],
      [textBlock("msg_2", "The answer is 42."), textBlock("msg_3", "The answer")],
    ],
    [
      "retains extensions across reasoning boundaries",
      [
        message("msg_1", "Step one."),
        { type: "reasoning", id: "rs_1", summary: [] },
        message("msg_2", "Step one. Step two."),
      ],
      [textBlock("msg_1", "Step one."), textBlock("msg_2", "Step one. Step two.")],
    ],
  ] as const)("completed-response backfill %s", async (_name, items, expected) => {
    expect((await streamOutput([completed(items)])).content).toEqual(expected);
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

  it("uses a valid Azure API version default when the environment is unset", () => {
    expect(resolveAzureOpenAIApiVersion({})).toBe("preview");
    expect(resolveAzureOpenAIApiVersion({ AZURE_OPENAI_API_VERSION: "2025-01-01-preview" })).toBe(
      "2025-01-01-preview",
    );
  });

  it("preserves Azure routing and prepared headers", async () => {
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "preview");
    const baseUrl = "https://example.openai.azure.com";
    const model = { ...createAzureResponsesModel(), baseUrl };
    const requests: Request[] = [];
    vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(`data: ${JSON.stringify(completed())}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const stream = await createAzureOpenAIResponsesTransportStreamFn()(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "test-key", headers: { session_id: "prepared-affinity" } },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    assert(request);
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe(`${baseUrl}/responses`);
    expect(url.searchParams.get("api-version")).toBe("preview");
    expect(request.headers.get("api-key")).toBe("test-key");
    expect(request.headers.get("session_id")).toBe("prepared-affinity");
  });

  it("does not replay terminal text that already streamed", async () => {
    const output = await streamOutput([
      itemEvent("added", { type: "message", id: "msg_streamed" }, 0),
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
          output: [message("msg_streamed", "STREAMED_HALF_SENTENCE", "text")],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        },
      },
    ]);

    expect(output.content).toMatchObject([{ type: "text", text: "STREAMED_HALF_SENTENCE" }]);
    expect(output.stopReason).toBe("length");
  });
});
