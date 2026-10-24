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

function catalog(inference: unknown) {
  return normalizeModelCatalog(
    { providers: { fixture: { models: [{ id: "typed", inference }] } } },
    { ownedProviders: new Set(["fixture"]) },
  );
}

function providerRow(inference: unknown) {
  const providerCatalog = catalog(inference)?.providers?.fixture;
  assert(providerCatalog, "Missing fixture catalog");
  return normalizeRows({ provider: "fixture", providerCatalog, source: "manifest" })[0];
}

function decisionRoute(overrides: Record<string, unknown>, chat = false) {
  return inferenceOf({ ...decision, ...overrides }, chat);
}

function inferenceOf(descriptor: unknown, chat = false) {
  return { chat, decision: descriptor };
}

it.each([inferenceOf({ protocol: "decision-v1", input: ["text"] }), inferenceOf(decision)])(
  "preserves minimal and full decision metadata: %j",
  (inference) => {
    const row = providerRow(inference);
    expect(row?.inference).toEqual(inference);
    expect(row).toMatchObject({ reasoning: false });
    for (const field of ["cost", "contextWindow", "maxTokens"]) {
      expect(row).not.toHaveProperty(field);
    }
  },
);

it("preserves a five-level score subset instead of advertising arbitrary rubric support", () => {
  const inference = inferenceOf({
    protocol: "fixture-scale",
    input: ["text"],
    questions: {
      score: { probabilities: "none", abstention: false, minOptions: 5, maxOptions: 5 },
    },
    billing: { unit: "requests", source: "provider-docs" },
  });
  const row = providerRow(inference);
  expect(row?.inference).toEqual(inference);
});

it("retains provider-defined estimates, confidence and Boolean criteria requirements", () => {
  const inference = inferenceOf({
    protocol: "fixture-legacy",
    input: ["text"],
    confidence: "provider-specific",
    questions: {
      boolean: { probabilities: "boolean", abstention: false, requiresCriteria: true },
      choice: { probabilities: "provider-defined", abstention: false },
    },
  });
  expect(catalog(inference)?.providers?.fixture?.models[0]?.inference).toEqual(inference);
});

it("keeps genuine dual capability explicit and preserves published zero token prices", () => {
  const inference = decisionRoute(
    { billing: { ...tokenBilling, usdPerMillion: { input: 0.042, output: 0 } } },
    true,
  );
  expect(catalog(inference)?.providers?.fixture?.models[0]?.inference).toEqual(inference);
  const unknown = catalog(decisionRoute({ billing: tokenBilling }));
  expect(unknown?.providers?.fixture?.models[0]?.inference?.decision?.billing).toEqual(
    tokenBilling,
  );
});

it("does not infer a task from legacy text or JSON compatibility flags", () => {
  const [row] = normalizeRows({
    provider: "fixture",
    source: "manifest",
    providerCatalog: {
      models: [
        {
          id: "ordinary",
          input: ["text"],
          compat: { supportsJsonSchemaResponseFormat: true, supportsTools: true },
        },
      ],
    },
  });
  expect(row).not.toHaveProperty("inference");
});

it.each([
  { chat: "false", decision },
  { decision },
  decisionRoute({ protocol: "https://fixture.invalid/decide" }),
  decisionRoute({ questions: {} }),
  decisionRoute({ questions: null }),
  decisionRoute({ questions: [] }),
  decisionRoute({ questions: { unknown: {} } }),
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
