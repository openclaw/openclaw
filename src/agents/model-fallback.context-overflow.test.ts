import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { buildEmbeddedRunBlockedResult } from "./embedded-agent-runner/run/blocked-run-result.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError } from "./failover-error.js";
import { model as catalogModel } from "./model-catalog-fixtures.test-support.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const guidance = "This message exceeds the model's context window on its own.";
const overflow = "Context window exceeded: requested 12000 tokens";
const defaults = {
  provider: "fixture-overflow",
  model: "primary",
  manifestPlugins: [],
  skipAuthProfileRuntime: true,
  classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
};
const answer: EmbeddedAgentRunResult = {
  payloads: [{ text: "The fallback answered." }],
  meta: { durationMs: 1 },
};
type FallbackParams = Parameters<typeof runWithModelFallback<EmbeddedAgentRunResult>>[0];
const runFallback = (run: FallbackParams["run"], options: Partial<FallbackParams> = {}) =>
  runWithModelFallback({ ...defaults, cfg: makeConfig(), run, ...options });
const overloaded = () => new FailoverError("temporarily overloaded", { reason: "overloaded" });
const attemptedModels = (run: { mock: { calls: unknown[][] } }) =>
  run.mock.calls.map((call) => call[1]);

function makeConfig(fallbacks = ["capped", "fit-first", "fit-second"]): OpenClawConfig {
  const model = {
    primary: "fixture-overflow/primary",
    fallbacks: fallbacks.map((id) => `fixture-overflow/${id}`),
  };
  const definition = (id: string, contextWindow: number, contextTokens: number) =>
    catalogModel(id, id, { contextWindow, contextTokens });
  const provider = {
    baseUrl: "http://127.0.0.1:11434",
    models: [
      definition("primary", 32768, 8192),
      definition("capped", 131072, 4096),
      definition("fit-first", 32768, 16384),
      definition("fit-second", 65536, 32768),
    ],
  };
  return {
    agents: { defaults: { model } },
    models: { providers: { "fixture-overflow": provider } },
  };
}

function blocked(
  kind: "context_overflow" | "compaction_failure" = "context_overflow",
  message = overflow,
): EmbeddedAgentRunResult {
  return buildEmbeddedRunBlockedResult({
    text: guidance,
    errorKind: kind,
    errorMessage: message,
    durationMs: 1,
    agentMeta: {
      sessionId: "overflow-fixture",
      provider: defaults.provider,
      model: defaults.model,
      contextTokens: 8192,
    },
    replayInvalid: false,
  });
}

describe("context overflow model fallback", () => {
  it.each(["context_overflow", "compaction_failure"] as const)(
    "prefers sufficient effective context caps after surfaced %s recovery",
    async (kind) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce(blocked(kind))
        .mockRejectedValueOnce(overloaded())
        .mockResolvedValueOnce(answer);
      const onFallbackStep = vi.fn();
      const result = await runFallback(run, { onFallbackStep });

      expect(attemptedModels(run)).toEqual(["primary", "fit-first", "fit-second"]);
      expect(result).toMatchObject({ outcome: "completed", model: "fit-second", result: answer });
      expect(result.attempts[0]).toMatchObject({ model: "primary", reason: "context_overflow" });
      expect(onFallbackStep).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackStepFromModel: "fixture-overflow/primary",
          fallbackStepToModel: "fixture-overflow/fit-first",
          fallbackStepFromFailureReason: "context_overflow",
        }),
      );
    },
  );

  it("retains unknown and undersized candidates after known sufficient candidates fail", async () => {
    const run = vi.fn(async (_provider: string, model: string) => {
      if (model === "primary") {
        return blocked();
      }
      if (model === "capped") {
        return answer;
      }
      throw overloaded();
    });
    const result = await runFallback(run, {
      cfg: makeConfig(["unknown", "capped", "fit-first", "fit-second"]),
    });
    expect(attemptedModels(run)).toEqual([
      "primary",
      "fit-first",
      "fit-second",
      "unknown",
      "capped",
    ]);
    expect(result.result).toBe(answer);
  });

  it("preserves the blocked guidance after every candidate rejects the oversized request", async () => {
    const run = vi.fn().mockResolvedValue(blocked());
    const result = await runFallback(run);
    expect(attemptedModels(run)).toEqual(["primary", "fit-first", "fit-second", "capped"]);
    expect(result).toMatchObject({
      outcome: "exhausted",
      result: {
        payloads: [{ text: guidance, isError: true }],
        meta: { error: { kind: "context_overflow" } },
      },
    });
  });

  it.each(["replay-invalid", "delivered", "empty override", "TPM ceiling"] as const)(
    "does not replay %s overflow results",
    async (guard) => {
      const failure =
        guard === "TPM ceiling"
          ? blocked(
              "context_overflow",
              "413 Request too large for model `fixture` on tokens per minute (TPM): Limit 8000, Requested 12000, please reduce your message size and try again.",
            )
          : blocked();
      if (guard === "replay-invalid") {
        failure.meta.replayInvalid = true;
      } else if (guard === "delivered") {
        failure.messagingToolSentTexts = ["Already delivered."];
      }
      const run = vi.fn().mockResolvedValue(failure);
      const result = await runFallback(
        run,
        guard === "empty override" ? { fallbacksOverride: [] } : {},
      );
      expect(run).toHaveBeenCalledOnce();
      expect(result.result).toBe(failure);
      if (guard === "empty override") {
        expect(result.outcome).toBe("exhausted");
      }
    },
  );

  it("retains configured order for non-overflow failures", async () => {
    const run = vi.fn().mockRejectedValueOnce(overloaded()).mockResolvedValueOnce(answer);
    const result = await runFallback(run);
    expect(attemptedModels(run)).toEqual(["primary", "capped"]);
    expect(result.result).toBe(answer);
  });

  it.each([
    overflow,
    "Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input.",
  ])("advances fallback for a thrown recognized overflow: %s", async (message) => {
    const run = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(answer);
    const result = await runFallback(run);
    expect(attemptedModels(run)).toEqual(["primary", "fit-first"]);
    expect(result.result).toBe(answer);
    expect(result.attempts[0]?.reason).toBe("context_overflow");
  });
});
