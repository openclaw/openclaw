import { streamSimpleOpenAIResponses } from "@openclaw/ai/internal/openai";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import { wrapOpenAIResponsesStream } from "./responses-stream.runtime.js";

const params = vi.hoisted(() => [] as unknown[]);

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: vi.fn((request: unknown) => {
        params.push(request);
        throw new Error("captured before sending");
      }),
    };
  },
}));

describe("Daybreak Responses requests", () => {
  it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
    "preserves %s and its advanced efforts through simple Responses requests",
    async (id) => {
      const row = manifest.modelCatalog.providers.openai.models.find((entry) => entry.id === id);
      if (!row) {
        throw new Error("Missing Daybreak catalog row");
      }
      const model: Model<"openai-responses"> = {
        id: row.id,
        name: row.name,
        reasoning: row.reasoning,
        contextWindow: row.contextWindow,
        maxTokens: row.maxTokens,
        compat: row.compat,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        cost: {
          input: row.cost.input,
          output: row.cost.output,
          cacheRead: row.cost.cacheRead,
          cacheWrite: row.cost.cacheWrite,
        },
      };
      for (const fastMode of [
        false,
        true,
        "ultrafast",
        "ULTRAFAST",
        () => "ULTRAFAST",
        () => false,
        () => true,
        () => "ultrafast",
      ] as const) {
        const stream = wrapOpenAIResponsesStream({
          provider: "openai",
          modelId: id,
          model,
          streamFn: streamSimple,
          nativeWebSearchAllowedByToolPolicy: false,
          extraParams: { fastMode },
        });
        const output = await stream(
          model,
          { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
          { apiKey: "synthetic-test-key" },
        );
        await output.result();
        expect(params.at(-1)).toMatchObject({ model: id });
        const requested = typeof fastMode === "function" ? fastMode() : fastMode;
        if (id === "gpt-daybreak-blue-latest" && requested !== false) {
          expect(params.at(-1)).toHaveProperty("service_tier", "priority");
        } else {
          expect(params.at(-1)).not.toHaveProperty("service_tier");
        }
      }
      for (const reasoning of ["xhigh", "max"] as const) {
        const result = await streamSimpleOpenAIResponses(
          model,
          { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
          { apiKey: "synthetic-test-key", reasoning },
        ).result();
        expect(result.errorMessage).toBe("captured before sending");
        expect(params.at(-1)).toMatchObject({ model: id, reasoning: { effort: reasoning } });
      }
    },
  );
});

it("uses host-admitted prompt updates on native Responses", () => {
  const policy = buildOpenAIReplayPolicy({
    provider: "openai",
    modelApi: "openai-responses",
    modelId: "gpt-5.4",
    inHistorySystemUpdates: true,
  });
  expect(policy.inHistorySystemUpdates).toBe(true);
});

it("owns replay policy for OpenAI and Codex transports", () => {
  const provider = buildOpenAIProvider();
  const codexProvider = buildOpenAIProvider();

  expect(
    provider.buildReplayPolicy?.({
      provider: "openai",
      modelApi: "openai",
      modelId: "gpt-5.4",
    } as never),
  ).toEqual({
    sanitizeMode: "images-only",
    applyAssistantFirstOrderingFix: false,
    sanitizeToolCallIds: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  });

  expect(
    provider.buildReplayPolicy?.({
      provider: "openai",
      modelApi: "openai-completions",
      modelId: "gpt-5.4",
    } as never),
  ).toEqual({
    sanitizeMode: "images-only",
    applyAssistantFirstOrderingFix: false,
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    duplicateToolCallIdStyle: "openai",
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
  });

  expect(
    codexProvider.buildReplayPolicy?.({
      provider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    } as never),
  ).toEqual({
    sanitizeMode: "images-only",
    applyAssistantFirstOrderingFix: false,
    sanitizeToolCallIds: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: true,
    appendOnlyRuntimeContext: true,
  });
});

describe("configured speed defaults", () => {
  const model: Model<"openai-responses"> = {
    id: "speed-fixture",
    name: "Speed fixture",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    contextWindow: 1_050_000,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  it("snapshots speed until the current payload finishes, then reads the next preference", async () => {
    let fastMode: boolean | "ultrafast" = "ultrafast";
    const stream = wrapOpenAIResponsesStream({
      provider: "openai",
      modelId: model.id,
      model,
      streamFn: streamSimple,
      nativeWebSearchAllowedByToolPolicy: false,
      extraParams: { serviceTier: "flex", fastMode: () => fastMode },
    });
    const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
    const first = await stream(model, context, {
      apiKey: "synthetic-test-key",
      onPayload: async (payload) => {
        fastMode = false;
        // Async callers can replace a payload; the in-flight speed must not change.
        await Promise.resolve();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Expected a Responses request object");
        }
        return { ...payload };
      },
    });
    expect((await first.result()).errorMessage).toBe("captured before sending");
    expect(params.at(-1)).toMatchObject({
      service_tier: "ultrafast",
      context_management: [{ type: "compaction", compact_threshold: 260_000 }],
    });
    const next = await stream(model, context, { apiKey: "synthetic-test-key" });
    expect((await next.result()).errorMessage).toBe("captured before sending");
    expect(params.at(-1)).toMatchObject({
      service_tier: "default",
      context_management: [{ type: "compaction", compact_threshold: 735_000 }],
    });
  });

  it.each(["serviceTier", "service_tier"])(
    "preserves inherited %s and lets each explicit speed override its request payload",
    async (key) => {
      for (const tier of ["auto", "default", "flex", "priority", "ultrafast"]) {
        for (const [fastMode, expected] of [
          [undefined, tier],
          [false, "default"],
          [true, "priority"],
          ["ultrafast", "ultrafast"],
        ] as const) {
          const stream = wrapOpenAIResponsesStream({
            provider: "openai",
            modelId: model.id,
            model,
            streamFn: streamSimple,
            nativeWebSearchAllowedByToolPolicy: false,
            extraParams: { [key]: tier, fastMode },
          });
          const output = await stream(
            model,
            { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
            { apiKey: "synthetic-test-key" },
          );
          expect((await output.result()).errorMessage).toBe("captured before sending");
          expect(params.at(-1)).toMatchObject({ model: model.id, service_tier: expected });
        }
      }
    },
  );
});
