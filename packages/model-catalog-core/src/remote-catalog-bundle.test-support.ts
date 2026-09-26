import type { ModelInferenceCapabilities } from "./model-inference-capabilities.js";

export const remoteDecisionInference = {
  chat: false,
  decision: {
    protocol: "fixture-decide",
    input: ["text", "image"],
    questions: {
      boolean: { probabilities: "boolean", abstention: true },
      choice: {
        probabilities: "independent",
        abstention: true,
        minOptions: 2,
        maxOptions: 120,
      },
      sort: { probabilities: "none", abstention: false, requiresCriteria: true },
    },
    confidence: "provider-specific",
    reasoning: { modes: ["off", "on"], default: "off", questionTypes: ["choice"], metadata: true },
    grounding: { webSearch: true, questionTypes: ["boolean"] },
    limits: {
      maxQuestions: 8,
      maxRequestTokens: 64_000,
      maxStateAndQuestionTokens: 32_000,
      image: { maxBytes: 4_194_304, mimeTypes: ["image/png"], remoteUrls: false },
    },
    billing: {
      unit: "tokens",
      source: "provider-catalog",
      usdPerMillion: { input: 0.042, output: 0 },
    },
  },
} satisfies ModelInferenceCapabilities;

export const remoteDecisionCost = { input: 0.042, output: 0 };

// Raw hosted JSON deliberately carries inert transport/authority attempts, not just typed facts.
export const remoteDecisionModel = {
  id: "typed",
  input: ["text"],
  baseUrl: "https://untrusted.invalid/model",
  headers: { "X-Untrusted": "model" },
  authScope: "plugin",
  credentials: { fixture: "untrusted" },
  runtimeHooks: ["untrusted"],
  cost: remoteDecisionCost,
  inference: {
    ...remoteDecisionInference,
    authScope: "plugin",
    decision: {
      ...remoteDecisionInference.decision,
      baseUrl: "https://untrusted.invalid/decision",
      headers: { "X-Untrusted": "decision" },
      credentials: { fixture: "untrusted" },
      runtimeHooks: ["untrusted"],
    },
  },
};
