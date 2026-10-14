import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { buildEmbeddedRunBlockedResult } from "./embedded-agent-runner/run/blocked-run-result.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError } from "./failover-error.js";
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

function makeConfig(fallbacks = ["capped", "fit-first", "fit-second"]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "fixture-overflow/primary",
          fallbacks: fallbacks.map((model) => `fixture-overflow/${model}`),
        },
      },
    },
    models: {
      providers: {
        "fixture-overflow": {
          baseUrl: "http://127.0.0.1:11434",
          models: [
            { id: "primary", contextWindow: 32768, contextTokens: 8192 },
            { id: "capped", contextWindow: 131072, contextTokens: 4096 },
            { id: "fit-first", contextWindow: 32768, contextTokens: 16384 },
            { id: "fit-second", contextWindow: 65536, contextTokens: 32768 },
          ].map<ModelDefinitionConfig>((model) =>
            Object.assign(model, {
              name: model.id,
              reasoning: false,
              input: ["text"] satisfies ModelDefinitionConfig["input"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            }),
          ),
        },
      },
    },
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
        .mockRejectedValueOnce(
          new FailoverError("temporarily overloaded", { reason: "overloaded" }),
        )
        .mockResolvedValueOnce(answer);
      const onFallbackStep = vi.fn();
      const result = await runWithModelFallback({
        ...defaults,
        cfg: makeConfig(),
        run,
        onFallbackStep,
      });

      expect(run.mock.calls.map((call) => call[1])).toEqual(["primary", "fit-first", "fit-second"]);
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
      throw new FailoverError("temporarily overloaded", { reason: "overloaded" });
    });
    const result = await runWithModelFallback({
      ...defaults,
      cfg: makeConfig(["unknown", "capped", "fit-first", "fit-second"]),
      run,
    });
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      "primary",
      "fit-first",
      "fit-second",
      "unknown",
      "capped",
    ]);
    expect(result.result).toBe(answer);
  });

  it("preserves overflow guidance when an explicit empty override disables fallback", async () => {
    const failure = blocked();
    const run = vi.fn().mockResolvedValue(failure);
    const result = await runWithModelFallback({
      ...defaults,
      cfg: makeConfig(),
      fallbacksOverride: [],
      run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: "exhausted", result: failure });
  });

  it("preserves the blocked guidance after every candidate rejects the oversized request", async () => {
    const run = vi.fn().mockResolvedValue(blocked());
    const result = await runWithModelFallback({ ...defaults, cfg: makeConfig(), run });
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      "primary",
      "fit-first",
      "fit-second",
      "capped",
    ]);
    expect(result).toMatchObject({
      outcome: "exhausted",
      result: {
        payloads: [{ text: guidance, isError: true }],
        meta: { error: { kind: "context_overflow" } },
      },
    });
  });

  it.each(["replay-invalid", "delivered"] as const)(
    "does not replay %s overflow results",
    async (guard) => {
      const failure = blocked();
      if (guard === "replay-invalid") {
        failure.meta.replayInvalid = true;
      } else {
        failure.messagingToolSentTexts = ["Already delivered."];
      }
      const run = vi.fn().mockResolvedValue(failure);
      const result = await runWithModelFallback({ ...defaults, cfg: makeConfig(), run });
      expect(run).toHaveBeenCalledOnce();
      expect(result.result).toBe(failure);
    },
  );

  it("retains configured order for non-overflow failures", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new FailoverError("temporarily overloaded", { reason: "overloaded" }))
      .mockResolvedValueOnce(answer);
    const result = await runWithModelFallback({ ...defaults, cfg: makeConfig(), run });
    expect(run.mock.calls.map((call) => call[1])).toEqual(["primary", "capped"]);
    expect(result.result).toBe(answer);
  });

  it("does not reinterpret a surfaced provider TPM ceiling as model context pressure", async () => {
    const failure = blocked(
      "context_overflow",
      "413 Request too large for model `fixture` on tokens per minute (TPM): Limit 8000, Requested 12000, please reduce your message size and try again.",
    );
    const run = vi.fn().mockResolvedValue(failure);
    const result = await runWithModelFallback({ ...defaults, cfg: makeConfig(), run });
    expect(run).toHaveBeenCalledOnce();
    expect(result.result).toBe(failure);
  });

  it.each([
    overflow,
    "Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input.",
  ])("advances fallback for a thrown recognized overflow: %s", async (message) => {
    const run = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(answer);
    const result = await runWithModelFallback({ ...defaults, cfg: makeConfig(), run });
    expect(run.mock.calls.map((call) => call[1])).toEqual(["primary", "fit-first"]);
    expect(result.result).toBe(answer);
    expect(result.attempts[0]?.reason).toBe("context_overflow");
  });
});
