import assert from "node:assert/strict";
import { validateDecisionResultV2, type DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { registeredPreparedDecisionProvider } from "./transport.test-support.js";

it
  .runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.TYPESAFE_API_KEY))
  .each(["text", "image"])(
  "evaluates a synthetic %s batch through the registered TypeSafe endpoint",
  async (kind) => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    assert(apiKey);
    // Supply an isolated prepared provider snapshot; never open the operator's secret store.
    const config = {
      models: {
        providers: {
          typesafe: {
            baseUrl: "https://api.typesafe.ai/v1",
            apiKey,
            models: [],
            // Configured provider routes do not inherit ambient proxies implicitly.
            // Opt into the supported consumer for process-scoped protected-key egress.
            ...(process.env.HTTPS_PROXY || process.env.https_proxy
              ? { request: { proxy: { mode: "env-proxy" as const } } }
              : {}),
          },
        },
      },
    };
    const provider = registeredPreparedDecisionProvider(() => config);
    const batch: DecisionBatchV2 = {
      state:
        kind === "image"
          ? {
              type: "image",
              // TypeSafe requires both dimensions >= 280px. No private image or caption answer.
              dataUri: `data:image/png;base64,${createSolidPngBuffer(320, 320, { r: 255, g: 0, b: 0 }).toString("base64")}`,
              text: "Inspect the image.",
            }
          : { type: "text", text: "The square is entirely red." },
      questions: {
        red: { type: "boolean", instructions: "Is the square red?" },
        color: {
          type: "choice",
          instructions: "What is the dominant color?",
          criteria: { red: "Red", blue: "Blue" },
        },
        coverage: {
          type: "score",
          instructions: "How much of the square is red?",
          criteria: ["None", "About half", "All"],
        },
      },
    };
    const outcome = await provider.evaluate(batch, {
      model: {
        provider: "typesafe",
        id: "jev-latest",
        name: "Jev",
        baseUrl: "https://api.typesafe.ai/v1",
      },
      config,
      auth: { mode: "api-key", apiKey },
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 30_000,
      isAdmissible: () => true,
    });
    if (outcome.status !== "ok") {
      throw new Error("TypeSafe live evaluation unavailable: " + outcome.reason);
    }
    expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
    const { answers, usage, model } = outcome.result;
    expect(answers.color).toMatchObject({ type: "choice", choice: "red" });
    assert(answers.red?.type === "boolean" && answers.coverage?.type === "score");
    expect(answers.red.probabilityTrue).toBeGreaterThan(0.5);
    expect(answers.coverage.score).toBeGreaterThan(1);
    // Only synthetic answers and usage, never request headers or credential-bearing config.
    console.log(JSON.stringify({ kind, model, answers, usage }));
    expect(outcome.result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
  },
  40_000,
);
