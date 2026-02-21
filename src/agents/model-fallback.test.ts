import { describe, expect, it } from "vitest";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback, _probeThrottleInternals } from "./model-fallback.js";

describe("runWithModelFallback", () => {
  it("skips same-provider candidates after a timeout failure", async () => {
    let callCount = 0;
    const calledModels: string[] = [];

    const result = await runWithModelFallback({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "nim/model-a",
              fallbacks: ["nim/model-b", "ollama/llama3"],
            },
          },
        },
      } as never,
      provider: "nim",
      model: "model-a",
      fallbacksOverride: ["nim/model-b", "ollama/llama3"],
      run: async (provider, model) => {
        callCount++;
        calledModels.push(`${provider}/${model}`);
        if (provider === "nim") {
          throw new FailoverError("LLM request timed out.", {
            reason: "timeout",
            provider,
            model,
            status: 408,
          });
        }
        return "success";
      },
    });

    expect(result.result).toBe("success");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3");
    // model-a attempted (timeout), model-b SKIPPED (same provider), llama3 succeeded
    expect(callCount).toBe(2);
    expect(calledModels).toEqual(["nim/model-a", "ollama/llama3"]);
    // Should have 3 attempt records: attempted, skipped, succeeded (but succeeded isn't in attempts)
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].reason).toBe("timeout");
    expect(result.attempts[1].reason).toBe("timeout");
    expect(result.attempts[1].error).toContain("skipped");
  });

  it("does not skip providers for non-timeout failures", async () => {
    const calledModels: string[] = [];

    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "nim",
      model: "model-a",
      fallbacksOverride: ["nim/model-b"],
      run: async (provider, model) => {
        calledModels.push(`${provider}/${model}`);
        if (model === "model-a") {
          throw new FailoverError("Rate limited.", {
            reason: "rate_limit",
            provider,
            model,
            status: 429,
          });
        }
        return "ok";
      },
    });

    // Both nim models should be attempted (rate_limit doesn't trigger provider skip)
    expect(calledModels).toEqual(["nim/model-a", "nim/model-b"]);
    expect(result.result).toBe("ok");
  });
});
