import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapOpenAIResponsesStream } from "./responses-stream.runtime.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const model: Parameters<StreamFn>[0] = {
  provider: "openai",
  id: "gpt-5.4",
  name: "Test model",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("token-sharing Responses stream", () => {
  it("enforces HTTP and complete-context replay after caller/provider payload transforms", async () => {
    let observed: Parameters<StreamFn>[2];
    let payloadResult: Promise<unknown> | undefined;
    const base: StreamFn = (selected, _context, options) => {
      observed = options;
      payloadResult = Promise.resolve(
        options?.onPayload?.(
          {
            input: [{ role: "user", content: "Hello" }],
            tools: [{ type: "function", name: "read_file", parameters: {} }],
          },
          selected,
        ),
      );
      return createAssistantMessageEventStream();
    };
    const stream = wrapOpenAIResponsesStream({
      provider: "openai",
      modelId: model.id,
      model,
      streamFn: base,
      auth: { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW },
      extraParams: { transport: "websocket", store: true, responsesServerCompaction: true },
    });
    void stream(
      model,
      { messages: [] },
      {
        transport: "websocket",
        onPayload: async (request) => ({
          ...(request as Record<string, unknown>),
          store: true,
          context_management: [{ type: "compaction", compact_threshold: 1000 }],
        }),
      },
    );
    const payload = (await payloadResult) as Record<string, unknown>;
    expect(observed).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
    expect(payload.store).toBe(false);
    expect(payload).not.toHaveProperty("context_management");
    expect(payload.input).toEqual([{ role: "user", content: "Hello" }]);
    expect(payload.tools).toEqual(
      expect.arrayContaining([
        { type: "function", name: "read_file", parameters: {} },
        { type: "web_search" },
      ]),
    );
  });
});
