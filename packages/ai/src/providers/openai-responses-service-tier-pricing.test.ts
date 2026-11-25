// Service-tier pricing has exactly one owner. A transport-local copy of this
// table previously drifted (flat 2x priority while gpt-5.5 priority is 2.5x),
// silently understating UI cost for managed-transport turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "../types.js";
import { applyResponsesServiceTierPricing } from "./openai-responses-shared.js";

function usage(): Usage {
  return {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 110,
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("applyResponsesServiceTierPricing", () => {
  it.each([
    ["default tier keeps base pricing", undefined, "gpt-5.5", 3.75],
    ["flex halves cost", "flex", "gpt-5.5", 1.875],
    ["priority doubles cost for most models", "priority", "gpt-5.6-luna", 7.5],
    ["priority is 2.5x for gpt-5.5", "priority", "gpt-5.5", 9.375],
    ["GPT-6.2 Astra Fast doubles cost", "priority", "gpt-6.2-astra", 7.5],
    ["GPT-6.2 Sol Fast doubles cost", "priority", "gpt-6.2-sol", 7.5],
  ] as const)("%s", (_name, tier, modelId, expectedTotal) => {
    const value = usage();
    applyResponsesServiceTierPricing(value, tier, { id: modelId });
    expect(value.cost.total).toBeCloseTo(expectedTotal, 10);
  });

  it.each(["gpt-6.2-astra", "gpt-6.2-sol", "openai/gpt-6.2-sol", "gpt-6.2-astra-2026-11-17"])(
    "prices %s Ultrafast across the Pacific promotion boundary",
    (id) => {
      for (const [now, expected, expectedWrite] of [
        ["2027-03-01T07:59:59.999Z", 11.25, 0.75],
        ["2027-03-01T08:00:00.000Z", 22.5, 1.5],
      ] as const) {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
        const value = usage();
        applyResponsesServiceTierPricing(value, "ultrafast", { id });
        expect(value.cost.total).toBe(expected);
        expect(value.cost.cacheWrite).toBe(expectedWrite);
      }
    },
  );
});
