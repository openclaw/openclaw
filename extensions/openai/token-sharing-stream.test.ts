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
        headers: { "X-OpenAI-ChatPass-Test": "stale", "X-Custom": "preserved" },
        onPayload: async (request) => ({
          ...(request as Record<string, unknown>),
          store: true,
          metadata: { caller: "must-not-send" },
          max_output_tokens: 128000,
          temperature: 0.4,
          top_p: 0.8,
          prompt_cache_retention: "24h",
          prompt_cache_options: { ttl: "30m" },
          service_tier: "priority",
          text: { verbosity: "low", format: { type: "json_object" } },
          context_management: [{ type: "compaction", compact_threshold: 1000 }],
        }),
      },
    );
    const payload = (await payloadResult) as Record<string, unknown>;
    expect(observed).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
    expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBe("codex-direct");
    expect(new Headers(observed?.headers).get("x-custom")).toBe("preserved");
    expect(payload.store).toBe(false);
    expect(payload).not.toHaveProperty("context_management");
    for (const field of [
      "metadata",
      "max_output_tokens",
      "temperature",
      "top_p",
      "prompt_cache_retention",
    ]) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(payload).toMatchObject({
      prompt_cache_options: { ttl: "30m" },
      service_tier: "priority",
      text: { verbosity: "low", format: { type: "json_object" } },
    });
    expect(payload.input).toEqual([{ role: "user", content: "Hello" }]);
    expect(payload.tools).toEqual(
      expect.arrayContaining([
        { type: "function", name: "read_file", parameters: {} },
        { type: "web_search" },
      ]),
    );
  });

  it.each([
    { auth: { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW }, sharing: true },
    { auth: { mode: "oauth" }, sharing: false },
    { auth: { mode: "api_key" }, sharing: false },
  ] as const)(
    "keeps isolated completions on their credential's route: $auth",
    async ({ auth, sharing }) => {
      let observed: Parameters<StreamFn>[2];
      let payloadResult: Promise<unknown> | undefined;
      const payload = { tools: [], max_output_tokens: 64, store: true };
      const base: StreamFn = (selected, _context, options) => {
        observed = options;
        payloadResult = Promise.resolve(options?.onPayload?.(payload, selected)).then(
          (transformed) => transformed ?? payload,
        );
        return createAssistantMessageEventStream();
      };
      const hooks = buildOpenAIResponsesProviderHooks();
      const wrapped = hooks.wrapSimpleCompletionStreamFn?.({
        provider: "openai",
        modelId: model.id,
        model,
        streamFn: base,
        auth,
      });
      if (!sharing) {
        expect(wrapped).toBeUndefined();
      }
      const stream = wrapped ?? base;
      await stream(model, { messages: [], tools: [] }, {});
      expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBe(
        sharing ? "codex-direct" : null,
      );
      const result = await payloadResult;
      expect(result).toMatchObject({ tools: [], store: !sharing });
      if (sharing) {
        expect(result).not.toHaveProperty("max_output_tokens");
        expect(observed).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
      } else {
        expect(result).toHaveProperty("max_output_tokens", 64);
      }
    },
  );

  it.each(["auto", "flex"])("rejects unsupported SIWC service tier %s", async (serviceTier) => {
    let payloadResult: Promise<unknown> | undefined;
    const stream = wrapOpenAIResponsesStream({
      provider: "openai",
      modelId: model.id,
      model,
      auth: { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW },
      extraParams: { serviceTier },
      streamFn: (selected, _context, options) => {
        payloadResult = Promise.resolve(options?.onPayload?.({}, selected));
        return createAssistantMessageEventStream();
      },
    });
    void stream(model, { messages: [] }, {});
    await expect(payloadResult).rejects.toThrow(
      "Sign in with ChatGPT does not support this service tier",
    );
  });

  it.each([{ mode: "api_key" }, { mode: "oauth" }] satisfies ProviderWrapStreamFnContext["auth"][])(
    "preserves ordinary Responses controls for $mode without a sharing grant",
    async (auth) => {
      let observed: Parameters<StreamFn>[2];
      let payloadResult: Promise<unknown> | undefined;
      const controls = {
        max_output_tokens: 512,
        temperature: 0.4,
        top_p: 0.8,
        prompt_cache_retention: "24h",
        metadata: { purpose: "test" },
        service_tier: "flex",
      };
      const stream = wrapOpenAIResponsesStream({
        provider: "openai",
        modelId: model.id,
        model,
        auth,
        streamFn: (selected, _context, options) => {
          observed = options;
          const payload = { ...controls };
          payloadResult = Promise.resolve(options?.onPayload?.(payload, selected)).then(
            (transformed) => transformed ?? payload,
          );
          return createAssistantMessageEventStream();
        },
      });
      void stream(model, { messages: [] }, { headers: { "x-custom": "preserved" } });
      expect(new Headers(observed?.headers).get("x-openai-chatpass-test")).toBeNull();
      expect(new Headers(observed?.headers).get("x-custom")).toBe("preserved");
      await expect(payloadResult).resolves.toMatchObject(controls);
    },
  );
});
