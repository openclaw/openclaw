import assert from "node:assert/strict";
import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "../index.js";

// Opt-in only: use a disposable test key with credits; never read ambient keys in production.
// mock-isolation: The live adapter test supplies its protected key without opening host secret state.
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: () => ({ revision: 1, value: process.env.SUBQ_API_KEY }),
}));

it.runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.SUBQ_API_KEY))(
  "evaluates a mixed synthetic batch through the registered SubQ endpoint",
  async () => {
    let provider: DecisionProviderV1 | undefined;
    plugin.register(
      createTestPluginApi({
        id: "subq",
        registerDecisionProvider(registered) {
          assert(registered.contractVersion === 1);
          provider = registered;
        },
      }),
    );
    assert(provider);
    const outcome = await provider.evaluate(
      {
        state: "The object is a red cube.",
        questions: {
          red: {
            type: "boolean",
            instructions: "Is the object red?",
            criteria: { true: "Red", false: "Not red" },
          },
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
      },
      {
        model: "subq-snap-preview",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 30_000,
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      throw new Error("SubQ live evaluation unavailable: " + outcome.reason);
    }
    expect(outcome.result.model).toBe("subq-snap-preview");
    expect(outcome.result.answers.red?.type).toBe("boolean");
    expect(outcome.result.answers.color?.type).toBe("choice");
    expect(outcome.result.answers.count?.type).toBe("score");
    expect(outcome.result.usage?.outputTokens).toBe(0);
  },
);
