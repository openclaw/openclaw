import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { evaluate, platformRoute } from "./model-auth-availability.test-support.js";
import { resolveModelCatalogServiceTiers } from "./model-catalog-service-tiers.js";
import { createPreparedAccountCatalogAccess } from "./prepared-model-runtime.catalog-auth.js";

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
  selectedCredential: {
    source: "profile",
    profileId: "fixture:account-a",
    identityKey: "profile:fixture:account-a",
    requirement: "subscription",
  },
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
  it.each(["synthetic-provider-key", undefined])(
    "offers embedded API-key tiers for provider config %j without a profile",
    (apiKey) => {
      const selected = evaluate({
        cfg: {
          models: { providers: { openai: { ...platformRoute, apiKey, models: [] } } },
        },
        env: { OPENAI_API_KEY: "synthetic-provider-key" },
        ref: { modelId: "synthetic-api-model", runtimeId: "openclaw" },
      });
      expect(selected.availability).toBe(true);
      expect(selected.selectedProfileId).toBeUndefined();
      expect(
        resolve({
          entry: { provider: "openai", id: "synthetic-api-model" },
          evaluation: selected,
          runtimeId: "openclaw",
          snapshot: { entries: [], routeVariants: [] },
        }),
      ).toEqual(["priority", "ultrafast"]);
    },
  );
  it.each(["literal", "ref"] as const)(
    "evicts %s binding downgrades on record and fences stale observers",
    (kind) => {
      const provider = {
        ...platformRoute,
        apiKey:
          kind === "ref"
            ? { source: "env" as const, provider: "default", id: "FIXTURE_KEY_A" }
            : "synthetic-key-a",
        models: [],
      };
      const cfg: OpenClawConfig = { models: { providers: { openai: provider } } };
      const env = { FIXTURE_KEY_A: "synthetic-key-a", FIXTURE_KEY_B: "synthetic-key-b" };
      const retirement = new AbortController();
      const accountCatalog = createPreparedAccountCatalogAccess(() => true, retirement.signal, cfg);
      const selected = () => evaluate({ cfg, env });
      const first = selected();
      const credential = first.selectedCredential;
      if (!credential || credential.source !== "direct") {
        throw new Error("Expected direct credential");
      }
      const tiers = (selectedEvaluation = selected()) =>
        resolve({
          entry: { provider: "openai", id: "synthetic-api-model" },
          evaluation: selectedEvaluation,
          runtimeId: "openclaw",
          snapshot: { entries: [], routeVariants: [] },
        });
      const observation = {
        modelId: "synthetic-api-model",
        runtimeId: "openclaw",
        ...platformRoute,
        requestedTier: "ultrafast",
        responseTier: "priority",
      };
      const record = accountCatalog.prepareServiceTierObserver({ selectedCredential: credential });
      expect(record(observation)).toBe(true);
      expect(tiers()).toEqual(["priority", "ultrafast"]);
      const republished = evaluate({ cfg: { ...cfg, gateway: { port: 19001 } }, env });
      expect(republished.selectedCredential?.source).toBe("direct");
      expect(tiers(republished)).toEqual(["priority", "ultrafast"]);
      expect(
        accountCatalog.readServiceTierObservation({
          ...observation,
          identityKey: credential.identityKey,
          modelId: "other-model",
        }),
      ).toBeUndefined();
      expect(
        accountCatalog.readServiceTierObservation({
          ...observation,
          identityKey: credential.identityKey,
          baseUrl: "https://other.example/v1",
        }),
      ).toBeUndefined();
      accountCatalog.reconcileAuth({ version: 1, profiles: {} }, () => true);
      expect(tiers()).toEqual(["priority", "ultrafast"]);
      const originalBinding = structuredClone(provider.apiKey);
      if (typeof provider.apiKey === "string") {
        provider.apiKey = "synthetic-key-b";
      } else {
        provider.apiKey.id = "FIXTURE_KEY_B";
      }
      const replacementBinding = provider.apiKey;
      expect(record(observation)).toBe(false);
      // Restoring the old binding must not revive an evicted observer.
      provider.apiKey = originalBinding;
      expect(record(observation)).toBe(false);
      provider.apiKey = replacementBinding;
      expect(
        accountCatalog.readServiceTierObservation({
          ...observation,
          identityKey: credential.identityKey,
        }),
      ).toBeUndefined();
      expect(record(observation)).toBe(false);
      const next = selected();
      expect(next.selectedCredential).toEqual(credential);
      expect(credential.identityKey).toBe("direct:openai");
      expect(tiers(next)).toEqual(["priority", "ultrafast"]);
      if (!next.selectedCredential) {
        throw new Error("Expected replacement credential");
      }
      const replacement = accountCatalog.prepareServiceTierObserver({
        selectedCredential: next.selectedCredential,
      });
      expect(replacement(observation)).toBe(true);
      retirement.abort();
      expect(replacement(observation)).toBe(false);
      expect(
        accountCatalog.readServiceTierObservation({
          ...observation,
          identityKey: credential.identityKey,
        }),
      ).toBeUndefined();
    },
  );
  it("projects only the selected account/model/runtime/route and clears unknown observations", () => {
    expect(resolve()).toEqual(["ultrafast"]);
    for (const overrides of [
      { runtimeId: "other-runtime" },
      { entry: { ...entry, id: "another-model" } },
      {
        evaluation: {
          ...evaluation,
          selectedProfileId: "fixture:account-b",
          selectedCredential: {
            source: "profile" as const,
            profileId: "fixture:account-b",
            identityKey: "profile:fixture:account-b",
          },
        },
      },
      {
        evaluation: { ...evaluation, selectedProfileId: undefined, selectedCredential: undefined },
      },
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
});
