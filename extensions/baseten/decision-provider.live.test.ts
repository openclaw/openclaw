import type { DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildBasetenDecisionProvider } from "./decision-provider.js";

const apiKey = process.env.BASETEN_API_KEY?.trim();
const live = isLiveTestEnabled(["BASETEN_LIVE_TEST"]) && Boolean(apiKey);
const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Please refund the duplicate subscription charge." },
  questions: {
    refund: { type: "boolean", instructions: "Is the customer requesting a refund?" },
    route: {
      type: "choice",
      instructions: "Choose the responsible team",
      criteria: { billing: "Payments and refunds", technical: "Technical troubleshooting" },
    },
    urgency: {
      type: "score",
      instructions: "Rate the urgency",
      criteria: ["Routine", "Emergency"],
    },
  },
};
(live ? describe : describe.skip)("Baseten native decisions live", () => {
  it.each([
    "decision-models/baseten-elephant-9b-latest",
    "decision-models/baseten-mammoth-27b-latest",
    "decision-models/baseten-joey-2b-latest",
  ])(
    "evaluates a mixed rubric with %s",
    async (id) => {
      const outcome = await buildBasetenDecisionProvider().evaluate(batch, {
        model: { id, name: id, provider: "baseten", baseUrl: "https://inference.baseten.co/v1" },
        auth: { mode: "api-key", apiKey },
        config: {},
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 60_000,
        isAdmissible: () => true,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") {
        throw new Error(outcome.reason);
      }
      expect(outcome.result.answers.route).toMatchObject({ type: "choice", choice: "billing" });
      expect(outcome.result.answers.refund).toMatchObject({
        type: "boolean",
        probabilityTrue: expect.any(Number),
      });
      expect(outcome.result.answers.urgency).toMatchObject({
        type: "score",
        probabilities: [expect.any(Number), expect.any(Number)],
      });
      expect(outcome.result.usage?.inputTokens).toBeGreaterThan(0);
      expect(outcome.result.usage?.outputTokens).toBe(3);
    },
    90_000,
  );
});
