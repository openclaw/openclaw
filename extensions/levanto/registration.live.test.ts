import assert from "node:assert/strict";
import { validateDecisionResultV2, type DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it.runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.LEVANTO_API_KEY))(
  "evaluates a mixed synthetic batch through the registered Sage endpoint",
  async () => {
    const apiKey = process.env.LEVANTO_API_KEY;
    assert(apiKey);
    const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
    plugin.register(createTestPluginApi({ id: "levanto", registerDecisionProvider }));
    const provider = registerDecisionProvider.mock.calls[0]?.[0];
    assert(provider?.contractVersion === 2);
    const batch: DecisionBatchV2 = {
      state: { type: "text", text: "The object is a red cube." },
      questions: {
        red: { type: "boolean", instructions: "Is the object red?" },
        color: {
          type: "choice",
          instructions: "What color is the object?",
          criteria: { red: "Red", blue: "Blue" },
        },
        count: {
          type: "score",
          instructions: "How many objects?",
          criteria: ["None", "One", "Two"],
        },
      },
    };
    // Prepared credentials are fixture input; transport and native response validation stay real.
    const outcome = await provider.evaluate(batch, {
      model: {
        provider: "levanto",
        id: "levanto-sage",
        name: "Sage",
        baseUrl: "https://sage.levanto.ai",
      },
      config: {},
      auth: { mode: "api-key", apiKey },
      reasoning: "off",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 30_000,
      isAdmissible: () => true,
    });
    if (outcome.status !== "ok") {
      throw new Error("Sage live evaluation unavailable: " + outcome.reason);
    }
    // Abstention is valid; per-question errors are not successful live qualification.
    expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
    expect(outcome.result.answers.red?.type).toBe("boolean");
    expect(outcome.result.answers.color?.type).toBe("choice");
    expect(outcome.result.answers.count?.type).toBe("score");
    if (outcome.result.usage) {
      expect(outcome.result.usage).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      });
      expect(outcome.result.usage).not.toHaveProperty("costUsd");
    }
  },
  40_000,
);
