import { describe, expect, it } from "vitest";
import { projectProviderCatalogOutcomes } from "../gateway/server-methods/models-list-public-projection.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { copyProviderCatalogOutcomes } from "../plugins/provider-catalog-result.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { resolveModelCatalogServiceTiers } from "./model-catalog-service-tiers.js";

const entry = { provider: "fixture", id: "opaque-model" };
const route = {
  api: "openai-responses",
  baseUrl: "https://fixture.example/v1",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
const capability = {
  modelId: entry.id,
  runtimeId: "fixture-native",
  api: route.api,
  baseUrl: route.baseUrl,
  serviceTiers: ["ultrafast"],
};
const outcome: ProviderCatalogOutcome = {
  provider: entry.provider,
  profileId: "fixture:account-a",
  status: "ready",
  modelServiceTiers: [capability],
};
const evaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedRoute: route,
  selectedProfileId: outcome.profileId,
};
function resolve(overrides: Partial<Parameters<typeof resolveModelCatalogServiceTiers>[0]> = {}) {
  return resolveModelCatalogServiceTiers({
    entry,
    evaluation,
    runtimeId: capability.runtimeId,
    snapshot: { entries: [], routeVariants: [], providerOutcomes: [outcome] },
    isCurrent: () => true,
    ...overrides,
  });
}
describe("account-bound catalog service tiers", () => {
  it("projects only the selected account/model/runtime/route and clears unknown observations", () => {
    expect(resolve()).toEqual(["ultrafast"]);
    for (const overrides of [
      { runtimeId: "other-runtime" },
      { entry: { ...entry, id: "another-model" } },
      { evaluation: { ...evaluation, selectedProfileId: "fixture:account-b" } },
      { evaluation: { ...evaluation, selectedProfileId: undefined } },
      { evaluation: { ...evaluation, selectedRoute: undefined } },
      { evaluation: { ...evaluation, availability: undefined } },
      {
        evaluation: {
          ...evaluation,
          selectedRoute: { ...route, baseUrl: "https://other.example/v1" },
        },
      },
      { isCurrent: () => false },
    ]) {
      expect(resolve(overrides)).toBeUndefined();
    }
    for (const status of ["auth-rejected", "unavailable"] as const) {
      expect(
        resolve({
          snapshot: { entries: [], routeVariants: [], providerOutcomes: [{ ...outcome, status }] },
        }),
      ).toBeUndefined();
    }
    expect(
      resolve({
        snapshot: {
          entries: [],
          routeVariants: [],
          providerOutcomes: [outcome],
          refreshFailed: true,
        },
      }),
    ).toBeUndefined();
  });
  it("copies ready capability facts but keeps all account tier maps off the public outcome", () => {
    const copied = copyProviderCatalogOutcomes({ outcomes: [outcome] });
    expect(copied).toEqual([outcome]);
    expect(copied[0]?.modelServiceTiers?.[0]?.serviceTiers).not.toBe(capability.serviceTiers);
    expect(projectProviderCatalogOutcomes(copied)).toEqual([
      { provider: entry.provider, profileId: outcome.profileId, status: "ready" },
    ]);
    expect(
      copyProviderCatalogOutcomes({ outcomes: [{ ...outcome, status: "unavailable" }] })[0],
    ).not.toHaveProperty("modelServiceTiers");
  });
});
