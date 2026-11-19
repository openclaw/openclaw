import { expect, it } from "vitest";
import { normalizeModelCatalogProviderRows } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import type { ModelInferenceCapabilities } from "../../packages/model-catalog-core/src/model-catalog-types.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const inference = {
  chat: false,
  decision: {
    protocol: "fixture-system-one",
    input: ["text"],
    questions: { choice: { probabilities: "categorical", abstention: false } },
    limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
    billing: {
      unit: "tokens",
      source: "provider-docs",
      usdPerMillion: { input: 0.042, output: 0 },
    },
  },
} satisfies ModelInferenceCapabilities;
const base: ModelCatalogEntry = {
  provider: "fixture",
  id: "typed",
  name: "Typed",
  baseUrl: "https://fixture.invalid/direct",
  inference,
};

it("carries task facts from normal catalog rows into prepared catalog metadata", () => {
  const [row] = normalizeModelCatalogProviderRows({
    provider: "fixture",
    source: "manifest",
    providerCatalog: { baseUrl: base.baseUrl, models: [{ id: base.id, inference }] },
  });
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("Missing fixture row");
  }
  expect(modelCatalogRowToEntry(row)).toMatchObject({
    provider: "fixture",
    id: "typed",
    inference,
  });
});

it("retains exact-route facts across label-only and equivalent URL overlays", () => {
  expect(
    overlayCatalogMetadata(base, { provider: base.provider, id: base.id, name: "Renamed" })
      .inference,
  ).toEqual(inference);
  expect(
    overlayCatalogMetadata(base, {
      ...base,
      inference: undefined,
      baseUrl: "https://fixture.invalid/direct/",
    }).inference,
  ).toEqual(inference);
});

it.each([{ baseUrl: "https://fixture.invalid/routed" }, { api: "openai-completions" as const }])(
  "does not carry capability, limits or pricing to a new physical route: %j",
  (route) => {
    const result = overlayCatalogMetadata(base, { ...base, ...route, inference: undefined });
    expect(result.inference).toEqual({ chat: false });
  },
);

it("replaces the entire task contract instead of blending direct and routed semantics", () => {
  const routed: ModelInferenceCapabilities = {
    chat: false,
    decision: {
      protocol: "fixture-decide",
      input: ["text"],
      questions: { choice: { probabilities: "independent", abstention: true } },
      billing: { unit: "decision-units", source: "provider-docs" },
    },
  };
  const overlay = { ...base, baseUrl: "https://fixture.invalid/routed", inference: routed };
  expect(overlayCatalogMetadata(base, overlay).inference).toEqual(routed);
  expect(overlayCatalogMetadata(base, overlay, { preserveBaseRoute: true }).inference).toEqual(
    inference,
  );
});

it("does not add task declarations to unchanged legacy chat catalog entries", () => {
  const legacy = { ...base, inference: undefined };
  expect(overlayCatalogMetadata(legacy, { ...legacy, name: "Legacy" }).inference).toBeUndefined();
});
