import { expect, it } from "vitest";
import { assertDeferredToolInventoryFits } from "./tool-inventory-budget.js";

it("admits under/equal names budgets and rejects overflow with an actionable diagnostic", () => {
  for (const size of [99, 100]) {
    expect(() =>
      assertDeferredToolInventoryFits({
        names: ["openclaw." + "a".repeat(size - 9)],
        contextTokens: 1000,
      }),
    ).not.toThrow();
  }
  expect(() =>
    assertDeferredToolInventoryFits({
      names: ["openclaw." + "a".repeat(92)],
      contextTokens: 1000,
      model: "catalog-model",
    }),
  ).toThrow(/toolCount=1, requiredSize=101, limit=100.*model=catalog-model/);
});

it("counts separators and UTF-16 units without a fixed floor or ceiling", () => {
  expect(() =>
    assertDeferredToolInventoryFits({ names: ["a", "😀"], contextTokens: 40 }),
  ).toThrow();
  expect(() =>
    assertDeferredToolInventoryFits({ names: ["a", "😀"], contextTokens: 50 }),
  ).not.toThrow();
  expect(() =>
    assertDeferredToolInventoryFits({ names: ["a".repeat(20_000)], contextTokens: 200_000 }),
  ).not.toThrow();
  expect(() => assertDeferredToolInventoryFits({ names: [], contextTokens: 1 })).not.toThrow();
});
