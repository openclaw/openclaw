import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";

function policy(
  model: Parameters<typeof resolveOpenAIResponsesPayloadPolicy>[0],
  options?: Parameters<typeof resolveOpenAIResponsesPayloadPolicy>[1],
) {
  return resolveOpenAIResponsesPayloadPolicy(
    { api: "openai-responses", provider: "openai", ...model },
    options,
  );
}

describe("openai responses payload policy", () => {
  it("does not coerce partial context windows for compaction thresholds", () => {
    const payload = {} satisfies Record<string, unknown>;
    applyOpenAIResponsesPayloadPolicy(
      payload,
      policy(
        { id: "gpt-5.4", baseUrl: "https://api.openai.com/v1", contextWindow: "200000tokens" },
        { enableServerCompaction: true, storeMode: "provider-policy" },
      ),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 80_000 }],
    });
  });

  it("strips store and prompt cache for proxy-like responses routes when requested", () => {
    const resolved = policy(
      { baseUrl: "https://proxy.example.com/v1", compat: { supportsStore: false } },
      { enablePromptCacheStripping: true, storeMode: "provider-policy" },
    );
    const payload = {
      store: false,
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(payload, resolved);

    expect(payload).toEqual({});
  });

  it("keeps disabled reasoning payloads on native OpenAI responses models that support none", () => {
    const payload = { reasoning: { effort: "none" } } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      policy({ id: "gpt-5.4", baseUrl: "https://api.openai.com/v1" }, { storeMode: "disable" }),
    );

    expect(payload).toEqual({ reasoning: { effort: "none" }, store: false });
  });

  it.each([
    { compat: undefined, keepsNone: false },
    { compat: { supportedReasoningEfforts: ["none", "low", "high"] }, keepsNone: true },
  ])(
    "uses explicit proxy effort capabilities to retain none=$keepsNone",
    ({ compat, keepsNone }) => {
      const payload = { reasoning: { effort: "none" } } satisfies Record<string, unknown>;

      applyOpenAIResponsesPayloadPolicy(
        payload,
        policy(
          { id: "gpt-5.6-luna", baseUrl: "https://proxy.example.com/v1", compat },
          { storeMode: "disable" },
        ),
      );

      expect(payload.reasoning).toEqual(keepsNone ? { effort: "none" } : undefined);
    },
  );

  it("strips status from input items for custom openai-responses endpoints", () => {
    const resolved = policy({
      id: "gpt-5.5",
      provider: "custom-provider",
      baseUrl: "http://custom-host:8317/v1",
    });
    expect(resolved.shouldStripInputStatus).toBe(true);

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
        { type: "function_call", call_id: "call_1", name: "test", arguments: "{}" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking..." }],
          status: "completed",
        },
      ],
    };
    applyOpenAIResponsesPayloadPolicy(payload, resolved);
    expect((payload.input[0] as Record<string, unknown>).status).toBeUndefined();
    expect((payload.input[2] as Record<string, unknown>).status).toBeUndefined();
    expect((payload.input[0] as { content: Array<{ status?: string }> }).content[0]?.status).toBe(
      "nested-domain-value",
    );
  });

  it.each([
    [false, undefined, false, undefined],
    [true, undefined, true, true],
    [true, "openai-chatgpt-responses", false, false],
  ] as const)("resolves continuation opt-in=%s for api=%s", (optIn, api, expectedOptIn, store) => {
    const resolved = policy(
      {
        provider: "omniroute",
        baseUrl: "https://omniroute.example.com/v1",
        ...(api
          ? { api, provider: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" }
          : {}),
        ...(optIn ? { compat: { supportsResponsesContinuation: true } } : {}),
      },
      { storeMode: api ? "disable" : "provider-policy" },
    );
    expect(resolved).toMatchObject({
      explicitContinuationOptIn: expectedOptIn,
      explicitStore: store,
    });
  });

  it.each(["https://proxy.example.com/v1"])(
    "honors explicit no-store for an opted-in model at %s",
    (baseUrl) => {
      const resolved = policy(
        { baseUrl, compat: { supportsResponsesContinuation: true } },
        { storeMode: "disable" },
      );
      const payload = { store: true };
      applyOpenAIResponsesPayloadPolicy(payload, resolved);
      expect(resolved.explicitContinuationOptIn).toBe(true);
      expect(payload.store).toBe(false);
    },
  );
});
