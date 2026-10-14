import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { FailoverError } from "./failover-error.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import { modelCircuitInternals } from "./model-fallback-circuit.js";
import { runWithModelFallback as runWithModelFallbackBase } from "./model-fallback-runner.js";
import { MODEL_FALLBACK_SKIPPED_CODE } from "./model-fallback.types.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const PRIMARY = { provider: "openai", model: "gpt-5.5" } as const;
const FALLBACK_REF = "anthropic/claude-opus-4-7";

function makeConfig(fallbacks: string[], circuitBreaker = true): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: `${PRIMARY.provider}/${PRIMARY.model}`,
          fallbacks,
          ...(circuitBreaker ? { circuitBreaker: { enabled: true } } : {}),
        },
      },
    },
  };
}

type FallbackParams = Parameters<typeof runWithModelFallbackBase<string>>[0];

function runWithModelFallback(
  params: Pick<FallbackParams, "cfg" | "run"> & Partial<FallbackParams>,
) {
  return runWithModelFallbackBase({
    ...PRIMARY,
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    ...params,
  });
}

function overloaded(provider: string = PRIMARY.provider, model: string = PRIMARY.model) {
  return new FailoverError("provider overloaded", { provider, model, reason: "overloaded" });
}

function primaryCircuitState() {
  return modelCircuitInternals.modelCircuitStates.get(
    modelCircuitInternals.circuitKey(PRIMARY.provider, PRIMARY.model),
  );
}

async function openPrimaryCircuit(cfg: OpenClawConfig): Promise<void> {
  const run = vi.fn(async (provider: string, model: string) => {
    if (provider === PRIMARY.provider) {
      throw overloaded(provider, model);
    }
    return "fallback-ok";
  });
  for (let index = 0; index < modelCircuitInternals.FAILURE_THRESHOLD; index += 1) {
    await runWithModelFallback({ cfg, run });
  }
  // Without an open circuit the recovery cases below would silently test nothing.
  expect(primaryCircuitState()?.openUntil).toBeGreaterThan(Date.now());
}

beforeEach(() => {
  resetFallbackSkipCacheForTest();
  modelCircuitInternals.modelCircuitStates.clear();
});

describe("model fallback route circuit breaker", () => {
  it("skips an intermittently degraded route after repeated transient failures", async () => {
    const cfg = makeConfig([FALLBACK_REF]);
    const primaryOutcomes = Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0 ? "success" : "failure",
    );
    let primaryCalls = 0;
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider !== PRIMARY.provider) {
        return "fallback-ok";
      }
      if (primaryOutcomes[primaryCalls++] === "failure") {
        throw overloaded(provider, model);
      }
      return "primary-ok";
    });

    for (const outcome of primaryOutcomes) {
      const turn = await runWithModelFallback({ cfg, run });
      expect(turn.result).toBe(outcome === "success" ? "primary-ok" : "fallback-ok");
    }
    const result = await runWithModelFallback({ cfg, run });

    expect(result.result).toBe("fallback-ok");
    expect(primaryCalls).toBe(primaryOutcomes.length);
    // A circuit skip is a local skip that carries the last transient reason,
    // not evidence of a new backend attempt.
    expect(result.attempts[0]).toMatchObject({
      ...PRIMARY,
      reason: "overloaded",
      code: MODEL_FALLBACK_SKIPPED_CODE,
    });
    expect(run).toHaveBeenLastCalledWith(
      "anthropic",
      "claude-opus-4-7",
      expect.objectContaining({ isFinalFallbackAttempt: true }),
    );
  });

  it("attempts an open route when the only fallback cannot reach transport", async () => {
    const cfg = makeConfig([FALLBACK_REF]);
    const sessionId = "session:circuit-last-runnable-route";
    // The fallback is auth-skipped for this session, so it exists in the
    // candidate array but is rejected before any provider call.
    markFallbackCandidateSkipped({
      sessionId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      reason: "auth",
      ttlMs: 60_000,
    });
    let primaryHealthy = false;
    const run = vi.fn(async (provider: string) => {
      if (provider !== PRIMARY.provider) {
        throw new Error("fallback must never reach transport in this test");
      }
      if (!primaryHealthy) {
        throw overloaded();
      }
      return "primary-recovered";
    });

    for (let index = 0; index < modelCircuitInternals.FAILURE_THRESHOLD; index += 1) {
      await expect(runWithModelFallback({ cfg, sessionId, run })).rejects.toSatisfy(
        isFallbackSummaryError,
      );
    }
    primaryHealthy = true;
    const recovered = await runWithModelFallback({ cfg, sessionId, run });

    expect(recovered.result).toBe("primary-recovered");
    expect(recovered.attempts.map((attempt) => attempt.provider)).not.toContain(PRIMARY.provider);
    // The successful last-route probe closes the circuit in place; the entry
    // stays so a superseded probe can still detect its stale generation.
    expect(primaryCircuitState()?.openUntil).toBe(0);
  });

  it("does not count a fallback the operator policy now denies as runnable", async () => {
    const cfg = makeConfig([FALLBACK_REF]);
    await openPrimaryCircuit(cfg);
    const policy = (deny: string[]) =>
      prepareOperatorModelPolicy({ cfg, policy: { deny }, manifestPlugins: [] });
    const source = {
      profileId: "fixture-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: policy([]),
    };
    const run = vi.fn(async (provider: string) =>
      provider === PRIMARY.provider ? "primary-recovered" : "fallback-ok",
    );

    // The runner re-checks the live policy per candidate. Revoking the fallback
    // after planning must make the gate probe the open primary instead of
    // skipping it for a fallback the runner will refuse to attempt.
    const result = await runWithModelFallback({
      cfg,
      run,
      operatorAuthority: createAdmittedRunOperatorAuthority(source),
      prepareCandidateChain: () => {
        source.modelPolicy = policy([FALLBACK_REF]);
      },
    });

    expect(result.result).toBe("primary-recovered");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("releases a half-open recovery probe when the attempt throws", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const cfg = makeConfig([FALLBACK_REF]);
    try {
      await openPrimaryCircuit(cfg);
      now += modelCircuitInternals.INITIAL_OPEN_MS + 1;
      const terminalError = new Error('Command lane "main" task timed out after 1000ms');
      terminalError.name = "CommandLaneTaskTimeoutError";

      await expect(
        runWithModelFallback({
          cfg,
          run: vi.fn().mockRejectedValue(terminalError),
        }),
      ).rejects.toBe(terminalError);

      const recoveryRun = vi.fn(async (provider: string) =>
        provider === PRIMARY.provider ? "primary-recovered" : "fallback-ok",
      );
      const recovered = await runWithModelFallback({ cfg, run: recoveryRun });
      expect(recovered.result).toBe("primary-recovered");
      expect(recoveryRun).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not close a half-open circuit on a chain-stopped result", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const cfg = makeConfig([FALLBACK_REF]);
    try {
      await openPrimaryCircuit(cfg);
      now += modelCircuitInternals.INITIAL_OPEN_MS + 1;
      const generation = primaryCircuitState()?.generation;

      const stopped = await runWithModelFallback({
        cfg,
        run: vi.fn(async () => "terminal-timeout"),
        classifyResult: () => ({ stopReason: "agent_run_terminal_timeout" }),
      });

      expect(stopped.result).toBe("terminal-timeout");
      // The lease is released for the next probe, but the route is not
      // declared recovered: a terminal stop says nothing about its health.
      expect(primaryCircuitState()).toMatchObject({ generation, halfOpenInFlight: false });
      expect(primaryCircuitState()?.openUntil).not.toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps trying the only candidate when no fallback can serve", async () => {
    const cfg = makeConfig([]);
    const failure = overloaded();
    const run = vi.fn().mockRejectedValue(failure);

    for (let index = 0; index <= modelCircuitInternals.FAILURE_THRESHOLD; index += 1) {
      await expect(runWithModelFallback({ cfg, run })).rejects.toBe(failure);
    }

    expect(run).toHaveBeenCalledTimes(modelCircuitInternals.FAILURE_THRESHOLD + 1);
    expect(modelCircuitInternals.modelCircuitStates.size).toBe(0);
  });

  it("leaves routing untouched when the circuit breaker is not enabled", async () => {
    const cfg = makeConfig([FALLBACK_REF], false);
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === PRIMARY.provider) {
        throw overloaded(provider, model);
      }
      return "fallback-ok";
    });

    for (let index = 0; index <= modelCircuitInternals.FAILURE_THRESHOLD; index += 1) {
      await runWithModelFallback({ cfg, run });
    }

    expect(run).toHaveBeenCalledTimes((modelCircuitInternals.FAILURE_THRESHOLD + 1) * 2);
    expect(modelCircuitInternals.modelCircuitStates.size).toBe(0);
  });
});
