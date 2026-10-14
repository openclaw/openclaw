import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "@openclaw/ai/transports";
/**
 * Regression coverage for OpenAI Responses payload policy.
 * Verifies storage consent, proxy compatibility, compaction, and reasoning mutations.
 */
import { describe, expect, it } from "vitest";

describe("openai responses payload policy", () => {
  it("does not coerce partial context windows for compaction thresholds", () => {
    const model = {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: "200000tokens",
    } satisfies {
      api: unknown;
      baseUrl: unknown;
      contextWindow: unknown;
      id: unknown;
      provider: unknown;
    };
    const payload = {} satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(model, {
        enableServerCompaction: true,
        storeMode: "provider-policy",
      }),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 80_000 }],
    });
  });

  it("strips store and prompt cache for proxy-like responses routes when requested", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
      },
      {
        enablePromptCacheStripping: true,
        storeMode: "provider-policy",
      },
    );
    const payload = {
      store: false,
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(payload, policy);

    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps disabled reasoning payloads on native OpenAI responses models that support none", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      reasoning: {
        effort: "none",
      },
      store: false,
    });
  });

  it.each([
    { compat: undefined, keepsNone: false },
    { compat: { supportedReasoningEfforts: ["none", "low", "high"] }, keepsNone: true },
  ])(
    "uses explicit proxy effort capabilities to retain none=$keepsNone",
    ({ compat, keepsNone }) => {
      const payload = {
        reasoning: {
          effort: "none",
        },
      } satisfies Record<string, unknown>;

      applyOpenAIResponsesPayloadPolicy(
        payload,
        resolveOpenAIResponsesPayloadPolicy(
          {
            api: "openai-responses",
            provider: "openai",
            id: "gpt-5.6-luna",
            baseUrl: "https://proxy.example.com/v1",
            compat,
          },
          { storeMode: "disable" },
        ),
      );

      expect(payload.reasoning).toEqual(keepsNone ? { effort: "none" } : undefined);
    },
  );

  it("strips status from input items for custom openai-responses endpoints", () => {
    const model = {
      id: "gpt-5.5",
      api: "openai-responses",
      provider: "custom-provider",
      baseUrl: "http://custom-host:8317/v1",
    } satisfies {
      api: unknown;
      baseUrl: unknown;
      id: unknown;
      provider: unknown;
    };
    const policy = resolveOpenAIResponsesPayloadPolicy(model);
    expect(policy.shouldStripInputStatus).toBe(true);

    const payload = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Hello",
              annotations: [],
              status: "nested-domain-value",
            },
          ],
          status: "completed",
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "test",
          arguments: "{}",
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking..." }],
          status: "completed",
        },
      ],
    };
    applyOpenAIResponsesPayloadPolicy(payload, policy);
    expect((payload.input[0] as Record<string, unknown>).status).toBeUndefined();
    expect((payload.input[2] as Record<string, unknown>).status).toBeUndefined();
    expect((payload.input[0] as { content: Array<{ status?: string }> }).content[0]?.status).toBe(
      "nested-domain-value",
    );
  });

  it("never promotes store for a custom endpoint without the explicit continuation opt-in", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        provider: "omniroute",
        baseUrl: "https://omniroute.example.com/v1",
      },
      { storeMode: "provider-policy" },
    );
    expect(policy.explicitContinuationOptIn).toBe(false);
    expect(policy.explicitStore).toBeUndefined();
  });

  it("promotes store for a custom endpoint once the operator opts a model in explicitly", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        provider: "omniroute",
        baseUrl: "https://omniroute.example.com/v1",
        compat: { supportsResponsesContinuation: true },
      },
      { storeMode: "provider-policy" },
    );
    expect(policy.explicitContinuationOptIn).toBe(true);
    expect(policy.explicitStore).toBe(true);
  });

  it.each(["https://proxy.example.com/v1"])(
    "honors explicit no-store for an opted-in model at %s",
    (baseUrl) => {
      const policy = resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          baseUrl,
          compat: { supportsResponsesContinuation: true },
        },
        { storeMode: "disable" },
      );
      const payload = { store: true };
      applyOpenAIResponsesPayloadPolicy(payload, policy);
      expect(policy.explicitContinuationOptIn).toBe(true);
      expect(payload.store).toBe(false);
    },
  );

  it("never lets the continuation opt-in flip ChatGPT/Codex store:false to true", () => {
    // The broad Responses API predicate includes ChatGPT, whose no-store contract is separate.
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        compat: { supportsResponsesContinuation: true },
      },
      { storeMode: "disable" },
    );
    expect(policy.explicitContinuationOptIn).toBe(false);
    expect(policy.explicitStore).toBe(false);
  });
});
