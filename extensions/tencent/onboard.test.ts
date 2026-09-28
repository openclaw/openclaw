import { describe, expect, it } from "vitest";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./api.js";
import { applyTokenHubConfig, applyTokenPlanConfig } from "./onboard.js";

describe("Tencent onboarding", () => {
  it.each([
    { providerId: "tencent-tokenhub", apply: applyTokenHubConfig, build: buildTokenHubProvider },
    { providerId: "tencent-tokenplan", apply: applyTokenPlanConfig, build: buildTokenPlanProvider },
  ])("keeps $providerId generated rows out of merge config", ({ providerId, apply, build }) => {
    expect(apply({}).models?.providers?.[providerId]?.models).toEqual([]);
    const provider = build();
    const authored = provider.models.map((model) =>
      Object.assign({}, model, { id: `operator-${model.id}` }),
    );
    const result = apply({
      models: { mode: "merge", providers: { [providerId]: { ...provider, models: authored } } },
    });
    expect(result.models?.providers?.[providerId]?.models).toEqual(authored);
  });
});
