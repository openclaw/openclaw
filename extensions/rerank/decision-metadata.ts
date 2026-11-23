import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";

export const RERANK_PROVIDER_ID = "rerank";

type DecisionCapabilities = NonNullable<
  NonNullable<DecisionProviderContextV2["model"]["inference"]>["decision"]
>;

/** Declared for configured rerank rows that do not author their own Decision facts. */
export const RERANK_DECISION_CAPABILITIES = {
  protocol: "rerank",
  input: ["text"],
  questions: {
    boolean: { probabilities: "boolean", abstention: false },
    choice: { probabilities: "independent", abstention: false, minOptions: 2 },
    sort: { probabilities: "none", abstention: false, minOptions: 1 },
  },
  confidence: "none",
} satisfies DecisionCapabilities;
