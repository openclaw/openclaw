import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { wrapOpenAIResponsesStream } from "./responses-stream.runtime.js";
import { buildOpenAIResponsesProviderHooks } from "./shared.js";
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

const apiControls = {
  metadata: { caller: "must-not-send" },
  max_output_tokens: 128000,
  temperature: 0.4,
  top_p: 0.8,
  prompt_cache_retention: "24h",
};

function captureRequest(
  payload: Record<string, unknown>,
  overrides: Partial<ProviderWrapStreamFnContext> = {},
) {
  let observed: Parameters<StreamFn>[2];
  let result: Promise<unknown> | undefined;
  const streamFn: StreamFn = (selected, _context, options) => {
    observed = options;
    result = Promise.resolve(options?.onPayload?.(payload, selected)).then(
      (transformed) => transformed ?? payload,
    );
    return createAssistantMessageEventStream();
  };
  return {
    streamFn,
    context: {
      provider: "openai",
      modelId: model.id,
      model,
      streamFn,
      auth: { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW },
      ...overrides,
    } satisfies ProviderWrapStreamFnContext,
    get options() {
      return observed;
    },
    get payload() {
      return result;
    },
  };
}

describe("token-sharing Responses stream", () => {
  it("enforces HTTP and complete-context replay after caller/provider payload transforms", async () => {
    const capture = captureRequest(
      {
        input: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", name: "read_file", parameters: {} }],
      },
      {
        extraParams: { transport: "websocket", store: true, responsesServerCompaction: true },
      },
    );
    const stream = wrapOpenAIResponsesStream(capture.context);
    void stream(
      model,
      { messages: [] },
      {
        transport: "websocket",
        headers: { "X-OpenAI-ChatPass-Test": "stale", "X-Custom": "preserved" },
        onPayload: async (request) => ({
          ...(request as Record<string, unknown>),
          store: true,
          ...apiControls,
          prompt_cache_options: { ttl: "30m" },
          service_tier: "priority",
          text: { verbosity: "low", format: { type: "json_object" } },
          context_management: [{ type: "compaction", compact_threshold: 1000 }],
        }),
      },
    );
    const payload = await capture.payload;
    const observed = capture.options;
    expect(observed).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
    expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBe("codex-direct");
    expect(new Headers(observed?.headers).get("x-custom")).toBe("preserved");
    for (const field of ["context_management", ...Object.keys(apiControls)]) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(payload).toMatchObject({
      store: false,
      prompt_cache_options: { ttl: "30m" },
      service_tier: "priority",
      text: { verbosity: "low", format: { type: "json_object" } },
      tools: expect.arrayContaining([
        { type: "function", name: "read_file", parameters: {} },
        { type: "web_search" },
      ]),
    });
    expect(payload).toHaveProperty("input", [{ role: "user", content: "Hello" }]);
  });

  it.each([
    { auth: { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW }, sharing: true },
    { auth: { mode: "oauth" }, sharing: false },
  ] as const)("isolated completion credential route: $sharing", async ({ auth, sharing }) => {
    const capture = captureRequest({ tools: [], max_output_tokens: 64, store: true }, { auth });
    const wrapped = buildOpenAIResponsesProviderHooks().wrapSimpleCompletionStreamFn?.(
      capture.context,
    );
    if (!sharing) {
      expect(wrapped).toBeUndefined();
    }
    const stream = wrapped ?? capture.streamFn;
    await stream(model, { messages: [], tools: [] }, {});
    const observed = capture.options;
    expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBe(
      sharing ? "codex-direct" : null,
    );
    const result = await capture.payload;
    expect(result).toMatchObject({ tools: [], store: !sharing });
    if (sharing) {
      expect(result).not.toHaveProperty("max_output_tokens");
      expect(observed).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
    } else {
      expect(result).toHaveProperty("max_output_tokens", 64);
    }
  });

  it("rejects an unsupported SIWC service tier", async () => {
    const capture = captureRequest({}, { extraParams: { serviceTier: "auto" } });
    const stream = wrapOpenAIResponsesStream(capture.context);
    void stream(model, { messages: [] }, {});
    await expect(capture.payload).rejects.toThrow(
      "Sign in with ChatGPT does not support this service tier",
    );
  });

  it.each(["api_key", "oauth"] as const)(
    "preserves ordinary Responses controls without a sharing grant: %s",
    async (mode) => {
      const controls = {
        ...apiControls,
        max_output_tokens: 512,
        metadata: { purpose: "test" },
        service_tier: "flex",
      };
      const capture = captureRequest({ ...controls }, { auth: { mode } });
      const stream = wrapOpenAIResponsesStream(capture.context);
      void stream(model, { messages: [] }, { headers: { "x-custom": "preserved" } });
      const observed = capture.options;
      expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBeNull();
      expect(new Headers(observed?.headers).get("x-custom")).toBe("preserved");
      await expect(capture.payload).resolves.toMatchObject(controls);
    },
  );
});
