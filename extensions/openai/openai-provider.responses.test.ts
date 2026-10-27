import { streamSimpleOpenAIResponses } from "@openclaw/ai/internal/openai";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
} from "openclaw/plugin-sdk/llm";
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
        expect(params.at(-1)).not.toHaveProperty("access_programs");
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

it.each([
  ["priority", { cyber: "daybreak_blue" }, true],
  ["ultrafast", { cyber: "daybreak_blue" }, "ultrafast"],
  ["priority", { cyber: "daybreak_red" }, undefined],
  ["default", { cyber: "standard" }, undefined],
  ["priority", {}, true],
] as const)(
  "combines %s with %j without substituting the model",
  async (serviceTier, accessPrograms, fastMode) => {
    const row = manifest.modelCatalog.providers.openai.models[0];
    if (!row) {
      throw new Error("Missing synthetic model template");
    }
    const model: Model<"openai-responses"> = {
      name: row.name,
      reasoning: row.reasoning,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      compat: row.compat,
      cost: {
        input: row.cost.input,
        output: row.cost.output,
        cacheRead: row.cost.cacheRead,
        cacheWrite: row.cost.cacheWrite,
      },
      id: "gpt-daybreak-fixture-2026-10-01",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      input: ["text"],
    };
    const stream = wrapOpenAIResponsesStream({
      provider: "openai",
      modelId: model.id,
      model,
      streamFn: streamSimple,
      nativeWebSearchAllowedByToolPolicy: false,
      extraParams: { serviceTier, fastMode, accessPrograms },
    });
    const output = await stream(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "synthetic-test-key", reasoning: "max" },
    );
    expect((await output.result()).errorMessage).toBe("captured before sending");
    expect(params.at(-1)).toMatchObject({
      model: "gpt-daybreak-fixture-2026-10-01",
      reasoning: { effort: "max" },
      service_tier: serviceTier,
    });
    expect(params.at(-1)).toHaveProperty("access_programs", accessPrograms);
  },
);

it.each([null, { cyber: null }, { cyber: "unknown" }, { cyber: "daybreak_blue", extra: true }])(
  "rejects invalid access-program settings before making a request: %j",
  (accessPrograms) => {
    const before = params.length;
    expect(() =>
      wrapOpenAIResponsesStream({
        provider: "openai",
        modelId: "synthetic-model",
        streamFn: streamSimple,
        nativeWebSearchAllowedByToolPolicy: false,
        extraParams: { accessPrograms },
      }),
    ).toThrow("params.accessPrograms");
    expect(params).toHaveLength(before);
  },
);

it.each(["priority", "ultrafast"])(
  "preserves subscription endpoint and %s alongside Daybreak",
  async (serviceTier) => {
    const model: Model<"openai-chatgpt-responses"> = {
      id: "gpt-6.1-sol",
      name: "Synthetic subscription",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const underlying = vi.fn<typeof streamSimple>((_model, _context, options) => {
      void Promise.resolve(
        options?.onPayload?.({ model: model.id, service_tier: serviceTier }, model),
      ).then((request) => params.push(request));
      return createAssistantMessageEventStream();
    });
    const stream = wrapOpenAIResponsesStream({
      provider: "openai",
      modelId: model.id,
      model,
      streamFn: underlying,
      nativeWebSearchAllowedByToolPolicy: false,
      extraParams: { accessPrograms: { cyber: "daybreak_blue" } },
    });
    await stream(model, { messages: [] }, {});
    await vi.waitFor(() =>
      expect(params.at(-1)).toEqual({
        model: model.id,
        service_tier: serviceTier,
        access_programs: { cyber: "daybreak_blue" },
      }),
    );
    expect(underlying.mock.calls[0]?.[0]).toBe(model);
  },
);
