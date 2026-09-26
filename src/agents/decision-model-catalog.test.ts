import { Check } from "typebox/value";
import { expect, it } from "vitest";
import {
  ModelsListParamsSchema,
  ModelsListResultSchema,
} from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { normalizeModelCatalogProviderRows } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import { buildPublicModelProjection } from "../gateway/server-methods/models-list-public-projection.js";
import {
  modelCatalogEntryMatchesTask,
  projectDecisionModelCatalog,
} from "../model-catalog/decision-compatibility.js";
import { normalizeManifestModelCatalog } from "../plugins/manifest-decision-catalog.js";
import { modelFromStaticCatalogRow } from "./embedded-agent-runner/model.static-catalog-row.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { projectModelCatalogEntryForRoute } from "./model-catalog-route.js";
import type { ModelCatalogRoutePolicy } from "./model-catalog-route.js";

const inference = {
  chat: false,
  decision: {
    protocol: "fixture",
    input: ["text"] as ("text" | "image")[],
    questions: {
      tags: { probabilities: "independent" as const, abstention: true },
      choice: { probabilities: "independent" as const, abstention: true, maxOptions: 12 },
    },
  },
};

it("uses canonical metadata for task discovery and never invents chat materialization or legacy facts", () => {
  const catalog = normalizeManifestModelCatalog({
    providers: [],
    cliBackends: [],
    decisionProviders: ["fixture"],
    decisionModels: [
      {
        provider: "fixture",
        id: "native",
        name: "Old",
        capabilities: {
          questionTypes: ["boolean"],
          confidence: "none",
          requiresBooleanCriteria: true,
        },
      },
    ],
    modelCatalog: {
      providers: { fixture: { models: [{ id: "native", name: "Native", inference }] } },
    },
  });
  const providerCatalog = catalog?.providers?.fixture;
  if (!providerCatalog) {
    throw new Error("Missing fixture catalog");
  }
  const [row] = normalizeModelCatalogProviderRows({
    provider: "fixture",
    providerCatalog,
    source: "manifest",
  });
  if (!row) {
    throw new Error("Missing fixture row");
  }
  const entry = modelCatalogRowToEntry(row);
  expect(entry.inference).toEqual(inference);
  expect(modelCatalogEntryMatchesTask(entry)).toBe(false);
  expect(modelCatalogEntryMatchesTask(entry, "decision")).toBe(true);
  expect(modelCatalogEntryMatchesTask(entry, "all")).toBe(true);
  expect(modelCatalogEntryMatchesTask({})).toBe(true);
  expect(() => modelFromStaticCatalogRow(row)).toThrow("does not support chat");
  expect(projectDecisionModelCatalog([entry])).toEqual([
    {
      id: "native",
      provider: "fixture",
      name: "Native",
      capabilities: { questionTypes: ["choice"], maxChoiceAlternatives: 12 },
    },
  ]);
  const wire = buildPublicModelProjection({
    ...entry,
    baseUrl: "https://private.invalid",
    params: { private: true },
  });
  expect(wire.inference).toEqual(inference);
  expect(wire).not.toHaveProperty("baseUrl");
  expect(wire).not.toHaveProperty("params");
  expect(Check(ModelsListResultSchema, { models: [wire] })).toBe(true);
  expect(Check(ModelsListParamsSchema, { task: "decision", preparedOnly: true })).toBe(true);
  expect(Check(ModelsListParamsSchema, { task: "other" })).toBe(false);
  const policy: ModelCatalogRoutePolicy = {
    resolveIdentity: (candidate) => ({
      id: candidate.id,
      key: `${candidate.provider}/${candidate.id}`,
    }),
    matchesRoute: (candidate, route) => candidate.baseUrl === route.baseUrl,
  };
  const routed = { ...entry, baseUrl: "https://fixture.invalid" };
  const selected = projectModelCatalogEntryForRoute({
    entry: routed,
    projection: {
      kind: "selected",
      policy,
      route: {
        api: "openai-responses",
        baseUrl: routed.baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
  });
  expect(selected.entry.inference).toEqual(inference);
  const unresolved = projectModelCatalogEntryForRoute({
    entry: routed,
    projection: { kind: "unresolved", policy },
  });
  expect(unresolved.entry.inference).toEqual({ chat: false });
  expect(modelCatalogEntryMatchesTask(unresolved.entry)).toBe(false);
});

it.each([true, false])(
  "round-trips legacy criteria requirement %s and confidence through one canonical projection",
  (requiresBooleanCriteria) => {
    const legacy = [
      { provider: "fixture", id: "unknown", name: "Unknown" },
      {
        provider: "fixture",
        id: "known",
        name: "Known",
        capabilities: {
          questionTypes: ["boolean", "choice", "score"],
          requiresBooleanCriteria,
          confidence: requiresBooleanCriteria ? "provider-specific" : "none",
          maxQuestions: 7,
          maxChoiceAlternatives: 9,
          maxScoreLevels: 5,
          maxInputTokens: 512,
          inputTokenScope: "state-plus-each-criterion",
        },
      },
    ];
    const providerCatalog = normalizeManifestModelCatalog({
      modelCatalog: undefined,
      decisionModels: legacy,
      providers: [],
      cliBackends: [],
      decisionProviders: ["fixture"],
    })?.providers?.fixture;
    if (!providerCatalog) {
      throw new Error("Missing fixture catalog");
    }
    const rows = normalizeModelCatalogProviderRows({
      provider: "fixture",
      providerCatalog,
      source: "manifest",
    });
    const entries = rows.map(modelCatalogRowToEntry);
    expect(projectDecisionModelCatalog(entries)).toEqual(
      legacy.toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(modelCatalogEntryMatchesTask(entry, "decision")).toBe(true);
      expect(modelCatalogEntryMatchesTask(entry, "chat")).toBe(false);
      expect(entry).not.toHaveProperty("cost");
      expect(entry).not.toHaveProperty("contextWindow");
      const wire = buildPublicModelProjection(entry);
      expect(Check(ModelsListResultSchema, { models: [wire] })).toBe(true);
      expect(wire.inference).toEqual(entry.inference);
    }
    expect(entries.find((entry) => entry.id === "unknown")?.inference?.decision).toEqual({
      protocol: "decision-v1",
      input: ["text"],
    });
    expect(entries.find((entry) => entry.id === "known")?.inference?.decision?.questions).toEqual({
      boolean: {
        probabilities: "boolean",
        abstention: false,
        requiresCriteria: requiresBooleanCriteria,
      },
      choice: { probabilities: "provider-defined", abstention: false, maxOptions: 9 },
      score: { probabilities: "provider-defined", abstention: false, maxOptions: 5 },
    });
  },
);

it.each([true, false])(
  "keeps declared chat eligibility in identity-only route projections (%s)",
  (chat) => {
    const source = {
      provider: "fixture",
      id: "scoped",
      name: "Scoped",
      inference: {
        chat,
        decision: {
          protocol: "fixture",
          input: ["text" as const],
          questions: { boolean: { probabilities: "boolean" as const, abstention: false } },
        },
      },
    };
    const projected = projectModelCatalogEntryForRoute({
      entry: source,
      projection: {
        kind: "unresolved",
        policy: {
          resolveIdentity: (value) => ({ id: value.id, key: "fixture/scoped" }),
          matchesRoute: () => false,
        },
      },
    });
    expect(projected.entry.inference).toEqual({ chat });
    expect(modelCatalogEntryMatchesTask(projected.entry, "chat")).toBe(chat);
    expect(modelCatalogEntryMatchesTask(projected.entry, "decision")).toBe(false);
  },
);
