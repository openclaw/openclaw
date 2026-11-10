import { assert, expect, it } from "vitest";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows as normalizeRows,
} from "./model-catalog-normalize.js";
import type { ModelInferenceCapabilities } from "./model-catalog-types.js";

const tokenBilling = { unit: "tokens", source: "provider-catalog" };

const decision = {
  protocol: "fixture-decide",
  input: ["text", "image"],
  questions: {
    boolean: { probabilities: "boolean", abstention: true },
    choice: {
      probabilities: "independent",
      abstention: true,
      minOptions: 2,
      maxOptions: 120,
      maxImageOptions: 20,
    },
    sort: { probabilities: "none", abstention: false },
    box: { probabilities: "none", abstention: false },
  },
  reasoning: {
    modes: ["auto", "off", "on"],
    default: "auto",
    questionTypes: ["boolean", "choice"],
    metadata: true,
  },
  grounding: { webSearch: true, questionTypes: ["boolean", "choice"] },
  limits: {
    maxRequestTokens: 131072,
    image: {
      maxBytes: 4194304,
      mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      remoteUrls: false,
    },
  },
  billing: { unit: "decision-units", source: "provider-docs" },
} satisfies NonNullable<ModelInferenceCapabilities["decision"]>;

function catalog(inference: unknown, fields: Record<string, unknown> = {}) {
  return normalizeModelCatalog(
    { providers: { fixture: { models: [{ id: "typed", inference, ...fields }] } } },
    { ownedProviders: new Set(["fixture"]) },
  );
}

function providerRow(inference: unknown, fields: Record<string, unknown> = {}) {
  const providerCatalog = catalog(inference, fields)?.providers?.fixture;
  assert(providerCatalog, "Missing fixture catalog");
  return normalizeRows({ provider: "fixture", providerCatalog, source: "manifest" })[0];
}

function inferenceOf(descriptor: Record<string, unknown>, chat = false) {
  return { chat, decision: { protocol: "fixture-decide", input: ["text"], ...descriptor } };
}

function decisionRoute(overrides: Record<string, unknown>, chat = false) {
  return inferenceOf({ ...decision, ...overrides }, chat);
}

it.each([
  inferenceOf(decision),
  inferenceOf({
    questions: {
      score: { probabilities: "none", abstention: false, minOptions: 5, maxOptions: 5 },
    },
    billing: { unit: "requests", source: "provider-docs" },
  }),
  inferenceOf({
    confidence: "provider-specific",
    questions: {
      boolean: { probabilities: "boolean", abstention: false, requiresCriteria: true },
      choice: { probabilities: "provider-defined", abstention: false },
    },
  }),
  decisionRoute({ billing: { ...tokenBilling, usdPerMillion: { input: 0.042, output: 0 } } }, true),
  decisionRoute({ billing: tokenBilling }),
])("preserves declared capabilities and billing without inventing metadata: %j", (inference) => {
  const row = providerRow(inference);
  expect(row?.inference).toEqual(inference);
  for (const field of ["cost", "contextWindow", "maxTokens"]) {
    expect(row).not.toHaveProperty(field);
  }
});

it("does not infer a task from legacy text or JSON compatibility flags", () => {
  expect(
    providerRow(undefined, {
      input: ["text"],
      compat: { supportsJsonSchemaResponseFormat: true, supportsTools: true },
    }),
  ).not.toHaveProperty("inference");
});

it.each([
  { chat: "false", decision },
  { decision },
  decisionRoute({ protocol: "https://fixture.invalid/decide" }),
  decisionRoute({ questions: {} }),
  decisionRoute({ questions: null }),
  decisionRoute({ questions: { boolean: {} } }),
  decisionRoute({ confidence: "calibrated" }),
  decisionRoute({
    questions: { boolean: { ...decision.questions.boolean, requiresCriteria: "true" } },
  }),
  decisionRoute({
    questions: {
      choice: { probabilities: "independent", abstention: true, minOptions: 5, maxOptions: 4 },
    },
  }),
  decisionRoute({ input: ["text", "text"] }),
  decisionRoute({ reasoning: { modes: ["off"], default: "on" } }),
  decisionRoute({ reasoning: { modes: ["off"], questionTypes: ["tags"] } }),
  decisionRoute({ limits: { maxRequestTokens: -1 } }),
  decisionRoute({ limits: { maxQuestions: 1.5 } }),
  decisionRoute({ input: ["text"] }),
  decisionRoute({
    billing: { unit: "decision-units", source: "provider-catalog", usdPerMillion: { input: 3 } },
  }),
])("drops invalid declarations instead of falling back to chat: %j", (inference) => {
  expect(catalog(inference)).toBeUndefined();
});

it("strips undeclared provider diagnostics and does not mutate the descriptor", () => {
  const supplied = {
    chat: false,
    decision: { ...decision, privateDiagnostic: "synthetic-only" },
    privateEndpoint: "https://fixture.invalid",
  };
  expect(catalog(supplied)?.providers?.fixture?.models[0]?.inference).toEqual({
    chat: false,
    decision,
  });
  expect(supplied).toHaveProperty("privateEndpoint");
});
