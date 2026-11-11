import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildGoogleDecisionProvider } from "./decision-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const apiKey = process.env.GEMINI_API_KEY?.trim();
const live = isLiveTestEnabled(["GEMINI_LIVE_TEST"]) && Boolean(apiKey);
const inference = manifest.modelCatalog.providers.google.models.find(
  (model) => model.id === "gemini-decision-1",
)!.inference as NonNullable<DecisionProviderContextV2["model"]["inference"]>;

function evaluate(batch: DecisionBatchV2) {
  return buildGoogleDecisionProvider().evaluate(batch, {
    model: {
      id: "gemini-decision-1",
      name: "Gemini Decision 1",
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      inference,
    },
    auth: { mode: "api-key", apiKey },
    config: {},
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 60_000,
    isAdmissible: () => true,
  });
}

(live ? describe : describe.skip)("Gemini native decisions live", () => {
  it("evaluates a mixed rubric", async () => {
    const outcome = await evaluate({
      state: { type: "json", value: { message: "I was charged twice for my order." } },
      questions: {
        refund: {
          type: "boolean",
          instructions: "Is the customer asking for money back?",
          criteria: { true: "A refund or reversal is requested.", false: "Any other request." },
        },
        route: {
          type: "choice",
          instructions: "Which department should handle this request?",
          criteria: { billing: "Payments and refunds", technical: "Problems using the product" },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this request?",
          criteria: ["Routine", "Time-sensitive", "Emergency"],
        },
      },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("ok");
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
      probabilities: [expect.any(Number), expect.any(Number), expect.any(Number)],
    });
    expect(outcome.result.usage?.inputTokens).toBeGreaterThan(0);
    expect(outcome.result.usage?.outputTokens).toBe(0);
  }, 90_000);

  it("evaluates inline image evidence", async () => {
    // A 1x1 red PNG.
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const outcome = await evaluate({
      state: { type: "image", dataUri, text: "Product photo." },
      questions: { red: { type: "boolean", instructions: "Is the image mostly red?" } },
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "ok",
      result: { answers: { red: { type: "boolean", probabilityTrue: expect.any(Number) } } },
    });
  }, 90_000);
});
