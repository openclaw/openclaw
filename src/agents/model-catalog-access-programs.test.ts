import { expect, it } from "vitest";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { resolveModelCatalogAccessPrograms } from "./model-catalog-access-programs.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const route = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
const entry = { provider: "openai", id: "synthetic-model" };
const observation = {
  modelId: entry.id,
  runtimeId: "openclaw",
  ...route,
  cyber: ["standard", "daybreak_blue"] as const,
};
const outcome = {
  provider: "openai",
  profileId: "openai:a",
  status: "ready" as const,
  modelAccessPrograms: [observation],
};
const snapshot: ModelCatalogSnapshot = {
  entries: [],
  routeVariants: [],
  providerOutcomes: [outcome],
};
const evaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedRoute: route,
  selectedCredential: { source: "profile", profileId: "openai:a", identityKey: "profile:a" },
};
const resolve = (changes: Partial<Parameters<typeof resolveModelCatalogAccessPrograms>[0]> = {}) =>
  resolveModelCatalogAccessPrograms({
    snapshot,
    entry,
    evaluation,
    runtimeId: "openclaw",
    isCurrent: () => true,
    ...changes,
  });

it("never reuses program entitlement across accounts, models, runtimes, routes or refreshes", () => {
  expect(resolve()).toEqual(["standard", "daybreak_blue"]);
  for (const changes of [
    { runtimeId: "codex" },
    { entry: { ...entry, id: "other" } },
    {
      evaluation: {
        ...evaluation,
        selectedCredential: {
          source: "profile" as const,
          profileId: "openai:b",
          identityKey: "profile:b",
        },
      },
    },
    {
      evaluation: {
        ...evaluation,
        selectedRoute: { ...route, baseUrl: "https://other.example/v1" },
      },
    },
    { evaluation: { ...evaluation, availability: undefined } },
    { isCurrent: () => false },
    { snapshot: { ...snapshot, refreshFailed: true } },
    { snapshot: { ...snapshot, pendingProviders: ["openai"] } },
    {
      snapshot: { ...snapshot, providerOutcomes: [{ ...outcome, status: "unavailable" as const }] },
    },
  ]) {
    expect(resolve(changes)).toBeUndefined();
  }
  expect(
    resolve({
      snapshot: {
        ...snapshot,
        providerOutcomes: [{ ...outcome, modelAccessPrograms: [{ ...observation, cyber: [] }] }],
      },
    }),
  ).toEqual([]);
});

it("uses native-owned observations only while native account ownership is current", () => {
  const nativeSnapshot = {
    ...snapshot,
    nativeProviderOutcomes: {
      codex: [
        {
          ...outcome,
          profileId: undefined,
          modelAccessPrograms: [
            { modelId: entry.id, runtimeId: "codex", cyber: ["daybreak_red"] as const },
          ],
        },
      ],
    },
  };
  const nativeEvaluation = {
    ...evaluation,
    selectedCredential: { source: "harness" as const },
    runtimeAuth: { id: "codex", source: "native" as const },
  };
  expect(
    resolve({ snapshot: nativeSnapshot, evaluation: nativeEvaluation, runtimeId: "codex" }),
  ).toEqual(["daybreak_red"]);
  expect(resolve({ snapshot: nativeSnapshot, runtimeId: "codex" })).toBeUndefined();
  expect(
    resolve({
      snapshot: nativeSnapshot,
      evaluation: { ...nativeEvaluation, runtimeAuth: undefined },
      runtimeId: "codex",
    }),
  ).toBeUndefined();
});
