import { describe, expect, it } from "vitest";
import "../../llm/ai-transport-host.js";
import { postOpenAIResponsesCompaction } from "../../../packages/ai/src/transports/openai-responses-compact-client.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import { normalizeUsage } from "../usage.js";
import { buildErrorAgentMeta, buildUsageAgentMetaFields } from "./run/helpers.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "./usage-accumulator.js";

const grokModel = {
  id: "grok-4-fast",
  name: "grok-4-fast",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  input: ["text"],
  contextWindow: 2_000_000,
  reasoning: false,
  cost: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
} as never;

const tieredGrokCost = {
  input: 0.2,
  output: 0.5,
  cacheRead: 0.05,
  cacheWrite: 0,
  tieredPricing: [
    {
      range: [0, 128_000] as [number, number],
      input: 0.2,
      output: 0.5,
      cacheRead: 0.05,
      cacheWrite: 0,
    },
    {
      range: [128_000, Number.POSITIVE_INFINITY] as [number, number],
      input: 0.4,
      output: 1,
      cacheRead: 0.1,
      cacheWrite: 0,
    },
  ],
};

async function compactWith(usage: Record<string, unknown>, model: unknown = grokModel) {
  return await postOpenAIResponsesCompaction({
    client: {
      post: async () => ({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "ENCRYPTED_WINDOW" }],
        usage,
      }),
    } as never,
    model: model as never,
    request: { model: "grok-4-fast", input: [] } as never,
    options: undefined,
  });
}

function buildAccumulator(compactionUsage: unknown) {
  const accumulator = createUsageAccumulator();
  mergeUsageIntoAccumulator(
    accumulator,
    normalizeUsage({ input: 1_000, output: 200, cost: { total: 0.0003 } } as never),
  );
  if (compactionUsage !== undefined) {
    mergeUsageIntoAccumulator(accumulator, normalizeUsage(compactionUsage as never));
  }
  return accumulator;
}

describe("Responses compact endpoint usage accounting", () => {
  it("prices the compaction call against the model it was billed against", async () => {
    const compacted = await compactWith({
      input_tokens: 120_000,
      output_tokens: 4_000,
      total_tokens: 124_000,
    });
    expect(compacted.usage.cost).toMatchObject({
      input: 0.024,
      output: 0.002,
      cacheRead: 0,
      cacheWrite: 0,
      total: expect.closeTo(0.026, 10),
    });
    expect(compacted.usage.input_tokens).toBe(120_000);
    expect(compacted.usage.output_tokens).toBe(4_000);
  });

  it("bills cache reads at the cache rate instead of the input rate", async () => {
    const compacted = await compactWith({
      input_tokens: 120_000,
      output_tokens: 4_000,
      total_tokens: 124_000,
      input_tokens_details: { cached_tokens: 100_000 },
    });
    expect(compacted.usage.cost).toMatchObject({
      input: 0.004,
      cacheRead: 0.005,
      output: 0.002,
      total: expect.closeTo(0.011, 10),
    });
  });

  it("keeps the run's cost after a server-side compaction and counts its tokens once", async () => {
    const compacted = await compactWith({
      input_tokens: 120_000,
      output_tokens: 4_000,
      total_tokens: 124_000,
    });
    const meta = buildUsageAgentMetaFields({
      usageAccumulator: buildAccumulator(compacted.usage),
      latestUsage: undefined,
      lastRunPromptUsage: undefined,
    });
    expect(meta.usage?.total).toBe(125_200);
    expect(meta.usage?.cost?.total).toBeCloseTo(0.0263, 10);
    expect(meta.costUsd).toBeCloseTo(0.0263, 10);
  });

  it("keeps costUsd on the error terminal path", async () => {
    const compacted = await compactWith({
      input_tokens: 120_000,
      output_tokens: 4_000,
      total_tokens: 124_000,
    });
    const errorMeta = buildErrorAgentMeta({
      sessionId: "s1",
      provider: "xai",
      model: "grok-4-fast",
      usageAccumulator: buildAccumulator(compacted.usage),
      lastRunPromptUsage: undefined,
    });
    expect(errorMeta.usage?.total).toBe(125_200);
    expect(errorMeta.costUsd).toBeCloseTo(0.0263, 10);
  });

  it("keeps costUsd for a tiered-pricing model", async () => {
    const compacted = await compactWith({
      input_tokens: 120_000,
      output_tokens: 4_000,
      total_tokens: 124_000,
    });
    const meta = buildUsageAgentMetaFields({
      usageAccumulator: buildAccumulator(compacted.usage),
      latestUsage: undefined,
      lastRunPromptUsage: undefined,
    });
    expect(
      estimateAggregateUsageCost({
        usage: meta.usage,
        provider: "xai",
        model: "grok-4-fast",
        cost: tieredGrokCost,
      }),
    ).toBeCloseTo(0.0263, 10);
  });

  it("reports a zero cost rather than throwing when the model carries no rates", async () => {
    const compacted = await compactWith(
      { input_tokens: 120_000, output_tokens: 4_000, total_tokens: 124_000 },
      { ...(grokModel as object), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    );
    expect(compacted.usage.cost).toMatchObject({ total: 0 });
    const meta = buildUsageAgentMetaFields({
      usageAccumulator: buildAccumulator(compacted.usage),
      latestUsage: undefined,
      lastRunPromptUsage: undefined,
    });
    expect(meta.costUsd).toBeCloseTo(0.0003, 10);
  });
});
