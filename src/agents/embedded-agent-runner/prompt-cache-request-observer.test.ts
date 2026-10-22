import { hash } from "node:crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";

let testScope = 0;
let currentTestScope = "";
const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;

function createObserver(
  sessionId: string,
  onObservation: Parameters<typeof createPromptCacheRequestObserver>[1] = () => {},
  promptCacheKey?: string,
) {
  return createPromptCacheRequestObserver(
    { sessionId, promptCacheKey, streamStrategy: "test" },
    onObservation,
  );
}

function requestContext(
  observer: ReturnType<typeof createObserver>,
  systemPrompt = "original system",
) {
  return observer.onModelRequest(model, { systemPrompt, messages: [] });
}

const inputChange = (fields: Record<string, unknown>) => ({
  input: [{ role: "user", content: "first", ...fields }],
});

function scopedKey(value: string): string {
  return `request-observer:${value}:${currentTestScope}`;
}

describe("prompt cache request observer", () => {
  beforeEach(() => {
    currentTestScope = String(++testScope);
  });
  afterEach(() => vi.restoreAllMocks());

  it("pairs a drop with the last measured wire request across missing usage and run boundaries", async () => {
    const sessionId = scopedKey("wire-pair");
    const request = async (key: string, cacheRead?: number) => {
      const observer = createObserver(sessionId);
      await observer.onModelRequest(model, { systemPrompt: "stable", messages: [] });
      const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
        payload: { prompt_cache_key: key, previous_response_id: "private-response", input: [] },
        encode: true,
      });
      observer.onModelUsage(cacheRead === undefined ? undefined : { cacheRead }, {
        scopeDigest: "same-scope",
        ...fingerprint,
      });
      return observer.getObservation();
    };
    expect((await request("private-first", 9_000))?.broke).toBe(false);
    await request("private-unmeasured");
    const dropped = await request("private-final", 2_000);
    expect(dropped).toMatchObject({
      broke: true,
      requests: {
        previous: {
          cacheKeyPresent: true,
          cacheKeyHash: hash("sha256", '"private-first"').slice(0, 16),
        },
        current: {
          cacheKeyPresent: true,
          cacheKeyHash: hash("sha256", '"private-final"').slice(0, 16),
        },
      },
    });
    expect(JSON.stringify(dropped)).not.toContain("private-");
    // A fresh request with the original key must compare against the measured drop.
    expect((await request("private-first", 0))?.requests?.previous?.cacheKeyHash).toBe(
      dropped?.requests?.current?.cacheKeyHash,
    );
  });

  it("keeps concurrent review and foreground usage in their own diagnostic sessions", async () => {
    const promptCacheKey = scopedKey("shared-provider-affinity");
    const context = { systemPrompt: "stable", messages: [] };
    const foregroundResult = vi.fn();
    const reviewResult = vi.fn();
    const foreground = createObserver(scopedKey("foreground"), foregroundResult, promptCacheKey);
    const review = createObserver(scopedKey("review"), reviewResult, promptCacheKey);
    await review.onModelRequest(model, context);
    await foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 9_000 });
    review.onModelUsage({ cacheRead: 0, input: 1_000 });
    expect(review.getObservation()).toMatchObject({ broke: false });
    await foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 2_000 });
    expect(foreground.getObservation()).toMatchObject({
      broke: true,
      previousCacheRead: 9_000,
      cacheRead: 2_000,
      dropCause: "unattributed:provider-prompt-unavailable",
    });
  });

  it.each(["omitted", "missing", "unavailable"] as const)(
    "retains the input change with %s usage",
    async (usage) => {
      const observer = createObserver(scopedKey("unfinished-request"));
      await requestContext(observer, "before");
      observer.onModelUsage({ cacheRead: 8_000 });
      await requestContext(observer, "after");
      if (usage !== "omitted") {
        observer.onModelUsage(
          usage === "missing"
            ? undefined
            : { cacheRead: 0, cacheTelemetry: { state: "unavailable" } },
        );
      }
      await requestContext(observer, "after");
      observer.onModelUsage({ cacheRead: 2_000 });
      expect(observer.getObservation()).toMatchObject({
        broke: true,
        dropCause: "tracked-input-change",
        changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
      });
    },
  );

  it.each([
    ["system", { instructions: "provider rewritten system" }, "provider-input-change:system"],
    ["tools", { tools: [{ type: "function", name: "changed" }] }],
    ["tools", { tools: [{ name: "read", type: "function" }] }],
    ["message:0.content", inputChange({ content: "private rewritten history" })],
    ["message:0.role", inputChange({ role: "assistant" })],
    ["message:0.id", inputChange({ id: "private-id" })],
    ["message:0.encrypted_content", inputChange({ encrypted_content: "private-ciphertext" })],
    ["message:0.order", { input: [{ content: "first", role: "user" }] }],
    ["message:0.other", inputChange({ "private-field-name": "private-value" })],
    ["message:0.removed", { input: [] }],
    ["parameters:reasoning", { reasoning: { effort: "high" } }],
    ["parameters:prompt_cache_key", { prompt_cache_key: "private-affinity" }],
    ["parameters:prompt_cache_retention", { prompt_cache_retention: "24h" }],
    ["parameters:prompt_cache_options", { prompt_cache_options: { ttl: "30m" } }],
    ["parameters:store", { store: false }],
    ["parameters:include", { include: ["reasoning.encrypted_content"] }],
    ["parameters:truncation", { truncation: "disabled" }],
    ["parameters:service_tier", { service_tier: "default" }],
    ["parameters:metadata", { metadata: { "private-name": "private-value" } }],
    ["parameters:other", { "private-parameter-name": "private-value" }],
    [
      "continuation:parameters:previous_response_id",
      { previous_response_id: "private-response" },
      "unattributed:continuation-wire-input",
    ],
    [
      "continuation:wire-input:0.content,parameters:previous_response_id",
      {
        previous_response_id: "private-response",
        input: [{ role: "user", content: "private-delta" }],
      },
    ],
    [
      "prefix-match",
      {
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "appended" },
        ],
      },
      "provider-cache-reuse-lost:unchanged-prefix",
    ],
  ] as const)(
    "identifies final encoded %s changes despite unchanged assembled context",
    async (expected, replacement, dropCause?: string) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const observer = createObserver(scopedKey(`wire-${expected}`));
      const payload = {
        instructions: "original system",
        tools: [{ type: "function", name: "read" }],
        input: [{ role: "user", content: "first" }],
        reasoning: { effort: "low" },
      };
      const measure = async (body: unknown, cacheRead: number) => {
        await requestContext(observer);
        const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
          payload: body,
          encode: true,
        });
        observer.onModelUsage(
          {
            cacheRead,
            contextUsage: { state: "available", promptTokens: 10_000, totalTokens: 10_100 },
          },
          { scopeDigest: "same-provider-scope", ...fingerprint },
          { responseId: "resp-cache-fixture" },
        );
        expect(JSON.stringify(fingerprint)).not.toContain("private");
      };
      await measure(payload, 9_000);
      clock.mockReturnValue(3_000);
      await measure({ ...payload, ...replacement }, 2_000);
      expect(observer.getObservation()).toMatchObject({
        broke: true,
        changes: null,
        providerPrefix: expected,
        requestGapMs: 2_000,
        promptTokens: 10_000,
        responseId: "resp-cache-fixture",
      });
      if (dropCause) {
        expect(observer.getObservation()?.dropCause).toBe(dropCause);
      }
      if (expected === "parameters:service_tier") {
        expect(observer.getObservation()?.requests?.current?.serviceTier).toBe("default");
      }
      expect(JSON.stringify(observer.getObservation())).not.toContain("private");
    },
  );

  it.each([
    {
      name: "three healthy calls then one",
      turns: [[10_000, 10_000, 10_000], [10_000]],
      misses: [],
    },
    {
      name: "one call then a miss and two hits",
      turns: [[10_000], [0, 10_000, 10_000]],
      misses: ["2:1"],
    },
    { name: "a complete miss below the drop threshold", turns: [[500], [0]], misses: ["2:1"] },
  ])("observes each request: $name", async ({ turns, misses }) => {
    const sessionId = scopedKey("request-usage");
    const observed: Array<{ request: string; cacheRead: number | undefined; broke: boolean }> = [];
    for (const [turnIndex, reads] of turns.entries()) {
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        (observation) =>
          observed.push({
            request: `${turnIndex + 1}:${observation.requestIndex}`,
            cacheRead: observation.cacheRead,
            broke: observation.broke,
          }),
      );
      for (const cacheRead of reads) {
        await observer.onModelRequest(
          { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
          {
            messages: [],
            systemPrompt: "stable prefix",
            tools: [{ name: "read", description: "Read text", parameters: Type.Object({}) }],
          },
        );
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
      }
    }
    expect(observed.map((entry) => entry.cacheRead)).toEqual(turns.flat());
    expect(observed.filter((entry) => entry.broke).map((entry) => entry.request)).toEqual(misses);
  });
});
