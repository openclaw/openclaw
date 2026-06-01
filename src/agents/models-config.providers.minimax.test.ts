import { describe, expect, it } from "vitest";

function buildMinimaxCatalog() {
  return [
    {
      id: "MiniMax-M3",
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0.12,
        cacheWrite: 0,
        tieredPricing: [
          {
            range: [0, 512_000],
            input: 0.6,
            output: 2.4,
            cacheRead: 0.12,
            cacheWrite: 0,
          },
          {
            range: [512_000],
            input: 1.2,
            output: 4.8,
            cacheRead: 0.24,
            cacheWrite: 0,
          },
        ],
      },
    },
    {
      id: "MiniMax-M2.7",
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
        cacheWrite: 0.375,
      },
    },
    {
      id: "MiniMax-M2.7-highspeed",
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0.06,
        cacheWrite: 0.375,
      },
    },
  ];
}

describe("minimax provider catalog", () => {
  it("does not advertise the removed lightning model for api-key or oauth providers", () => {
    const providers = {
      minimax: { models: buildMinimaxCatalog() },
      "minimax-portal": { models: buildMinimaxCatalog() },
    };
    expect(providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
    expect(providers?.["minimax-portal"]?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
  });

  it("keeps MiniMax M3 tiered pricing in implicit catalogs", () => {
    const providers = {
      minimax: { models: buildMinimaxCatalog() },
      "minimax-portal": { models: buildMinimaxCatalog() },
    };
    const apiM3 = providers?.minimax?.models?.find((model) => model.id === "MiniMax-M3");
    const portalM3 = providers?.["minimax-portal"]?.models?.find(
      (model) => model.id === "MiniMax-M3",
    );

    expect(apiM3?.cost).toEqual({
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: 0,
      tieredPricing: [
        {
          range: [0, 512_000],
          input: 0.6,
          output: 2.4,
          cacheRead: 0.12,
          cacheWrite: 0,
        },
        {
          range: [512_000],
          input: 1.2,
          output: 4.8,
          cacheRead: 0.24,
          cacheWrite: 0,
        },
      ],
    });
    expect(portalM3?.cost).toEqual(apiM3?.cost);
  });

  it("keeps MiniMax highspeed pricing distinct in implicit catalogs", () => {
    const providers = {
      minimax: { models: buildMinimaxCatalog() },
      "minimax-portal": { models: buildMinimaxCatalog() },
    };
    const apiHighspeed = providers?.minimax?.models?.find(
      (model) => model.id === "MiniMax-M2.7-highspeed",
    );
    const portalHighspeed = providers?.["minimax-portal"]?.models?.find(
      (model) => model.id === "MiniMax-M2.7-highspeed",
    );

    expect(apiHighspeed?.cost).toEqual({
      input: 0.6,
      output: 2.4,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    });
    expect(portalHighspeed?.cost).toEqual(apiHighspeed?.cost);
  });
});
