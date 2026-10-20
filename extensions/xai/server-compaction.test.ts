import {
  captureOpenAIResponsesCompaction,
  createOpenAIResponsesTransportStreamFn,
  requestPreparedOpenAIResponsesCompaction,
} from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function wrapResponses(options: { fastMode?: boolean; clientVersion?: string }): StreamFn {
  const wrapped = wrapXaiProviderStream(
    {
      streamFn: createOpenAIResponsesTransportStreamFn(),
      extraParams: { fastMode: options.fastMode, tool_stream: false },
    } as never,
    { clientVersion: options.clientVersion },
  );
  if (!wrapped) {
    throw new Error("expected xAI stream wrapper");
  }
  return wrapped;
}

async function capturePayload(
  streamFn: StreamFn,
  targetModel: Model<"openai-responses">,
  context: Context,
  options: NonNullable<Parameters<StreamFn>[2]>,
) {
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
}

beforeEach(() => {
  sdkState.clients.length = 0;
  sdkState.post.mockReset();
  sdkState.post.mockResolvedValue({
    object: "response.compaction",
    output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
    usage: { input_tokens: 1_000, output_tokens: 200 },
  });
});

describe("xAI server compaction request preparation", () => {
  it("compacts and replays through the legacy fast-mode wrapper", async () => {
    const streamFn = wrapResponses({ fastMode: true });
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

    const compacted = await requestPreparedOpenAIResponsesCompaction(streamFn, model, context, {
      apiKey: "test-key",
      sessionId: "session-1",
    });

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

    const replayPayload = await capturePayload(
      streamFn,
      model,
      {
        ...context,
        messages: [
          ...context.messages,
          { role: "user", content: "What was the code?", timestamp: 3 },
        ],
      },
      { apiKey: "test-key", sessionId: "session-1" },
    );

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
    const streamFn = wrapResponses({ clientVersion: "2026.7.2" });
    const oauthModel = {
      ...model,
      id: "grok-4.5",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
    } satisfies Model<"openai-responses">;
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const options = {
      apiKey: "test-key",
      sessionId: "session-1",
      headers: { "X-Existing": "kept" },
    };

    await requestPreparedOpenAIResponsesCompaction(streamFn, oauthModel, context, options);
    const compactHeaders = sdkState.clients[0]?.defaultHeaders;

    await capturePayload(streamFn, oauthModel, context, options);
    const normalHeaders = sdkState.clients[1]?.defaultHeaders;

    expect(compactHeaders).toEqual(normalHeaders);
    expect(compactHeaders).toMatchObject({
      "x-existing": "kept",
      "x-grok-client-version": "2026.7.2",
      "x-grok-model-override": "grok-4.5",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });
});
