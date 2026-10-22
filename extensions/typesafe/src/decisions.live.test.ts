import assert from "node:assert/strict";
import { validateDecisionResultV2, type DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "../index.js";

it.runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.TYPESAFE_API_KEY))(
  "evaluates a mixed synthetic batch through the registered TypeSafe endpoint",
  async () => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    assert(apiKey);
    // Supply an isolated prepared provider snapshot; never open the operator's secret store.
    const config = {
      models: {
        providers: {
          typesafe: { baseUrl: "https://api.typesafe.ai/v1", apiKey, models: [] },
        },
      },
    };
    const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
    const api = createTestPluginApi({ id: "typesafe", registerDecisionProvider });
    api.runtime.config = {
      current: () => config,
      mutateConfigFile: vi.fn(),
      replaceConfigFile: vi.fn(),
    };
    plugin.register(api);
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
    expect(outcome.result.answers.red?.type).toBe("boolean");
    expect(outcome.result.answers.color?.type).toBe("choice");
    expect(outcome.result.answers.count?.type).toBe("score");
    expect(outcome.result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
  },
  40_000,
);
