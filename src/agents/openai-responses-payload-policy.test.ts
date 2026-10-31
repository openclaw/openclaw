import {
  applyOpenAIResponsesPayloadPolicy as apply,
  resolveOpenAIResponsesPayloadPolicy as resolve,
} from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";

function policy(model: Parameters<typeof resolve>[0], options?: Parameters<typeof resolve>[1]) {
  return resolve({ api: "openai-responses", provider: "openai", ...model }, options);
}

describe("openai responses payload policy", () => {
  it("does not coerce partial context windows for compaction thresholds", () => {
    const payload = {} satisfies Record<string, unknown>;
    apply(
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

    apply(payload, resolved);

    expect(payload).toEqual({});
  });

  it.each([
    { baseUrl: "https://api.openai.com/v1", id: "gpt-5.4", compat: undefined, keepsNone: true },
    {
      baseUrl: "https://proxy.example.com/v1",
      id: "gpt-5.6-luna",
      compat: undefined,
      keepsNone: false,
    },
    {
      baseUrl: "https://proxy.example.com/v1",
      id: "gpt-5.6-luna",
      compat: { supportedReasoningEfforts: ["none", "low", "high"] },
      keepsNone: true,
    },
  ])("retains none=$keepsNone at $baseUrl", ({ baseUrl, id, compat, keepsNone }) => {
    const payload = { reasoning: { effort: "none" } } satisfies Record<string, unknown>;

    apply(payload, policy({ id, baseUrl, compat }, { storeMode: "disable" }));

    expect(payload.reasoning).toEqual(keepsNone ? { effort: "none" } : undefined);
  });

  it.each([
    ["http://custom-host:8317/v1", [undefined, undefined, undefined, undefined]],
    [
      "https://ark.cn-beijing.volces.com/api/v3",
      ["completed", "completed", "incomplete", "completed"],
    ],
    [
      "https://ark.ap-southeast.bytepluses.com/api/v3",
      ["completed", "completed", "incomplete", "completed"],
    ],
  ])("applies the replayed input status policy at %s", (baseUrl, statuses) => {
    const resolved = policy({ id: "gpt-5.5", provider: "custom-provider", baseUrl });
    const content = [{ type: "output_text", text: "Hello", status: "nested-domain-value" }];
    const payload = {
      input: [
        { type: "message", role: "assistant", content, status: "completed" },
        { type: "function_call", call_id: "call_1", name: "test", arguments: "{}" },
        { type: "reasoning", summary: [], status: "incomplete" },
        { type: "reasoning", summary: [] },
      ],
    };
    apply(payload, resolved);
    expect(payload.input.map((item) => (item as { status?: string }).status)).toEqual(statuses);
    expect(payload.input[0]?.content).toEqual(content);
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

  it("honors explicit no-store for an opted-in proxy model", () => {
    const resolved = policy(
      { baseUrl: "https://proxy.example.com/v1", compat: { supportsResponsesContinuation: true } },
      { storeMode: "disable" },
    );
    const payload = { store: true };
    apply(payload, resolved);
    expect(resolved.explicitContinuationOptIn).toBe(true);
    expect(payload.store).toBe(false);
  });
});
