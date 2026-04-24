import { describe, expect, it, vi } from "vitest";
import {
  createContractFallbackConfig,
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "../../test/helpers/agents/outcome-fallback-runtime-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithModelFallback } from "./model-fallback.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "./pi-embedded-runner/result-fallback-classifier.js";

describe("Outcome/fallback runtime contract - Pi fallback classifier", () => {
  it.each([
    ["empty", "empty_result"],
    ["reasoning-only", "reasoning_only_result"],
    ["planning-only", "planning_only_result"],
  ] as const)(
    "maps harness classification %s to a format fallback code",
    (classification, code) => {
      expect(
        classifyEmbeddedPiRunResultForModelFallback({
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          result: createContractRunResult({
            meta: {
              durationMs: 1,
              agentHarnessResultClassification: classification,
            },
          }),
        }),
      ).toMatchObject({
        reason: "format",
        code,
      });
    },
  );

  it("advances to the configured fallback after a classified GPT-5 terminal result", async () => {
    const primary = createContractRunResult({
      meta: {
        durationMs: 1,
        agentHarnessResultClassification: "empty",
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "fallback ok" }],
      meta: { durationMs: 1, finalAssistantVisibleText: "fallback ok" },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback({
      cfg: createContractFallbackConfig() as OpenClawConfig,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      run,
      classifyResult: ({ provider, model, result }) =>
        classifyEmbeddedPiRunResultForModelFallback({
          provider,
          model,
          result,
        }),
    });

    expect(result.result).toBe(fallback);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual([
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
    ]);
    expect(result.attempts[0]).toMatchObject({
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      reason: "format",
      code: "empty_result",
    });
  });

  it("does not fallback for intentional silence, visible replies, aborts, or tool side effects", () => {
    const cases = [
      createContractRunResult({
        meta: { durationMs: 1, finalAssistantRawText: "NO_REPLY" },
      }),
      createContractRunResult({
        payloads: [{ text: "visible answer" }],
        meta: { durationMs: 1 },
      }),
      createContractRunResult({
        meta: { durationMs: 1, aborted: true, agentHarnessResultClassification: "empty" },
      }),
      createContractRunResult({
        meta: { durationMs: 1, toolSummary: { calls: 1, tools: ["message"] } },
      }),
    ];

    for (const result of cases) {
      expect(
        classifyEmbeddedPiRunResultForModelFallback({
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          result,
        }),
      ).toBeNull();
    }
  });
});
