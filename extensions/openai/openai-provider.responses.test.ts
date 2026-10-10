import { streamSimpleOpenAIResponses } from "@openclaw/ai/internal/openai";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
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

it.each([false, true])(
  "uses host-admitted prompt updates on native Responses (enabled=%s)",
  (inHistorySystemUpdates) => {
    const policy = buildOpenAIReplayPolicy({
      provider: "openai",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      inHistorySystemUpdates,
    });
    expect(policy.inHistorySystemUpdates).toBe(inHistorySystemUpdates || undefined);
  },
);
