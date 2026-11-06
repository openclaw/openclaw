import {
  captureOpenAIResponsesCompaction,
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "@openclaw/ai/transports";
import type { Context, Model, ModelRequestHeaders } from "openclaw/plugin-sdk/llm";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import { wrapXaiProviderStream } from "./stream.js";
import { captureXaiRequest, xaiModel } from "./test-helpers.js";

const sdkState = vi.hoisted(() => {
  const clients: Array<{ defaultHeaders?: ModelRequestHeaders }> = [];
  return { clients, post: vi.fn() };
});

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: { defaultHeaders?: ModelRequestHeaders }) {
      sdkState.clients.push(options);
    }

    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

const model = xaiModel({
  id: "grok-4",
  baseUrl: "https://api.x.ai/v1",
});

function prepareRequests(
  context: Context,
  targetModel: Model<"openai-responses"> = model,
  wrapper: { fastMode?: boolean; clientVersion?: string } = {},
) {
  const streamFn = wrapXaiProviderStream(
    {
      streamFn: createOpenAIResponsesTransportStreamFn(),
      extraParams: { fastMode: wrapper.fastMode, tool_stream: false },
    } as never,
    wrapper,
  );
  if (!streamFn) {
    throw new Error("expected xAI stream wrapper");
  }
  const options = {
    apiKey: "test-key",
    sessionId: "session-1",
    headers: { "X-Existing": "kept" },
  };
  return {
    compact: () =>
      requestPreparedOpenAIResponsesCompaction(streamFn, targetModel, context, options),
    replay: async () => {
      let captured: Record<string, unknown> | undefined;
      const stream = await streamFn(targetModel, context, {
        ...options,
        onPayload: (payload) => {
          captured = structuredClone(payload as Record<string, unknown>);
          throw new Error("stop after request payload capture");
        },
      });
      await stream.result();
      return captured;
    },
  };
}

beforeEach(() => {
  sdkState.clients.length = 0;
  sdkState.post.mockReset().mockResolvedValue({
    object: "response.compaction",
    output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
    usage: { input_tokens: 1_000, output_tokens: 200 },
  });
});

it("compacts and replays through the legacy xAI fast-mode wrapper", async () => {
  const owner = makeAgentAssistantMessage({
    content: [{ type: "text", text: "remembered" }],
    provider: "xai",
    model: "grok-4-fast",
    timestamp: 2,
  });
  const context: Context = {
    systemPrompt: "Retain the conversation.",
    messages: [{ role: "user", content: "Remember NORTH-COPPER-17.", timestamp: 1 }, owner],
  };

  const requests = prepareRequests(context, model, { fastMode: true });
  const compacted = await requests.compact();

  expect(sdkState.post).toHaveBeenCalledWith(
    "/responses/compact",
    expect.objectContaining({ body: expect.objectContaining({ model: "grok-4-fast" }) }),
  );
  expect(compacted.historyMode).toBe("compacted-prefix");
  captureOpenAIResponsesCompaction(
    owner,
    compacted.item,
    owner.content.length,
    compacted.model,
    compacted.replayMetadata,
  );

  context.messages.push({ role: "user", content: "What was the code?", timestamp: 3 });
  const replayPayload = await requests.replay();

  expect(replayPayload).toMatchObject({
    model: "grok-4-fast",
    instructions: "Retain the conversation.",
    input: [
      { type: "compaction", encrypted_content: "opaque" },
      { role: "user", type: "message" },
    ],
  });
  expect(JSON.stringify(replayPayload)).not.toContain("NORTH-COPPER-17");
});

it("uses the same OAuth proxy headers as a normal turn", async () => {
  const target = xaiModel({
    id: "grok-4.7",
    name: "Subscription default",
    input: ["text"],
    params: { canonicalModelId: "grok-fixture-unselected" },
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
  });
  const contract = {
    "x-grok-client-version": "2026.7.2",
    "x-grok-model-override": target.id,
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  const captured = captureXaiRequest(target, {
    extraParams: { tool_stream: false },
    headers: { "X-XAI-Token-Auth": "operator-value", "X-Existing": "kept", "x-delete": null },
  });
  expect(captured.modelId).toBe(target.id);
  expect(captured.headers).toEqual({ "X-Existing": "kept", "x-delete": null, ...contract });
  const requests = prepareRequests(
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    target,
    { clientVersion: "2026.7.2" },
  );
  await requests.compact();
  await requests.replay();
  const [compactHeaders, normalHeaders] = sdkState.clients.map((client) => client.defaultHeaders);
  expect(compactHeaders).toEqual(normalHeaders);
  expect(Object.fromEntries(new Headers(omitNullRequestHeaders(compactHeaders)))).toMatchObject(
    Object.fromEntries(new Headers({ "X-Existing": "kept", ...contract })),
  );
});
