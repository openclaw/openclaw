import { describe, expect, it } from "vitest";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderRows,
} from "./model-catalog-normalize.js";
import type { ModelInferenceCapabilities } from "./model-catalog-types.js";

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

describe("route inference capabilities", () => {
  it("preserves independent probabilities, abstention and task-specific reasoning without inventing chat or prices", () => {
    const normalized = catalog({ chat: false, decision });
    const providerCatalog = normalized?.providers?.fixture;
    expect(providerCatalog).toBeDefined();
    if (!providerCatalog) {
      throw new Error("Missing fixture catalog");
    }
    const [row] = normalizeModelCatalogProviderRows({
      provider: "fixture",
      providerCatalog,
      source: "manifest",
    });
    expect(row?.inference).toEqual({ chat: false, decision });
    expect(row).not.toHaveProperty("cost");
    expect(row).not.toHaveProperty("maxTokens");
    // The conversational reasoning flag is not inferred from the decision reasoning pass.
    expect(row?.reasoning).toBe(false);
  });

  it("keeps genuine dual capability explicit and preserves published zero token prices", () => {
    const inference = {
      chat: true,
      decision: {
        ...decision,
        billing: {
          unit: "tokens",
          source: "provider-catalog",
          usdPerMillion: { input: 0.042, output: 0 },
        },
      },
    };
    expect(catalog(inference)?.providers?.fixture?.models[0]?.inference).toEqual(inference);
    const unknown = catalog({
      chat: false,
      decision: { ...decision, billing: { unit: "tokens", source: "provider-catalog" } },
    });
    expect(unknown?.providers?.fixture?.models[0]?.inference?.decision?.billing).toEqual({
      unit: "tokens",
      source: "provider-catalog",
    });
  });

  it("does not infer a task from legacy text or JSON compatibility flags", () => {
    const [row] = normalizeModelCatalogProviderRows({
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
    { chat: false, decision: { ...decision, protocol: "https://fixture.invalid/decide" } },
    { chat: false, decision: { ...decision, questions: {} } },
    { chat: false, decision: { ...decision, input: ["text", "text"] } },
    { chat: false, decision: { ...decision, reasoning: { modes: ["off"], default: "on" } } },
    {
      chat: false,
      decision: { ...decision, reasoning: { modes: ["off"], questionTypes: ["tags"] } },
    },
    { chat: false, decision: { ...decision, limits: { maxRequestTokens: -1 } } },
    { chat: false, decision: { ...decision, limits: { maxQuestions: 1.5 } } },
    { chat: false, decision: { ...decision, input: ["text"] } },
    {
      chat: false,
      decision: {
        ...decision,
        billing: {
          unit: "decision-units",
          source: "provider-catalog",
          usdPerMillion: { input: 3 },
        },
      },
    },
  ])(
    "drops invalid declared rows instead of silently treating them as legacy chat: %j",
    (inference) => {
      expect(catalog(inference)).toBeUndefined();
    },
  );

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
});
