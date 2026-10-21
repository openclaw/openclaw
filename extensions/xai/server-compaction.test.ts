import {
  captureOpenAIResponsesCompaction,
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, vi } from "vitest";
import { wrapXaiProviderStream } from "./stream.js";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(options: Record<string, unknown>) {
      sdkState.clients.push(options);
    }

    post = sdkState.post;
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

const model = {
  id: "grok-4",
  name: "Grok 4",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

function prepareRequests(
  context: Context,
  targetModel: Model<"openai-responses"> = model,
  wrapper: { fastMode?: boolean; clientVersion?: string } = {},
) {
  const streamFn: StreamFn | undefined = wrapXaiProviderStream(
    {
      streamFn: createOpenAIResponsesTransportStreamFn(),
      extraParams: { fastMode: wrapper.fastMode, tool_stream: false },
    } as never,
    { clientVersion: wrapper.clientVersion },
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

  expect(replayPayload?.model).toBe("grok-4-fast");
  // Normal replay carries the system prompt in instructions, not compaction input.
  expect(replayPayload?.instructions).toBe("Retain the conversation.");
  expect(replayPayload?.input).toEqual([
    expect.objectContaining({ type: "compaction", encrypted_content: "opaque" }),
    expect.objectContaining({ role: "user", type: "message" }),
  ]);
  expect(JSON.stringify(replayPayload)).not.toContain("NORTH-COPPER-17");
});

it("uses the same OAuth proxy headers as a normal turn", async () => {
  const requests = prepareRequests(
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    { ...model, id: "grok-4.5", baseUrl: "https://cli-chat-proxy.grok.com/v1" },
    { clientVersion: "2026.7.2" },
  );
  await requests.compact();
  const compactHeaders = sdkState.clients[0]?.defaultHeaders;

  await requests.replay();
  const normalHeaders = sdkState.clients[1]?.defaultHeaders;

  expect(compactHeaders).toEqual(normalHeaders);
  expect(compactHeaders).toMatchObject({
    "x-existing": "kept",
    "x-grok-client-version": "2026.7.2",
    "x-grok-model-override": "grok-4.5",
    "x-xai-token-auth": "xai-grok-cli",
  });
});
