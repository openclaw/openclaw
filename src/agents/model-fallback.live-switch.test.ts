import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { FailoverError } from "./failover-error.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { runWithModelFallback as runWithModelFallbackBase } from "./model-fallback-runner.js";
import {
  makeModelFallbackCfg as makeCfg,
  createModelFallbackConfig,
} from "./test-helpers/model-fallback-config-fixture.js";

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const runWithModelFallback: typeof runWithModelFallbackBase = (params) =>
  runWithModelFallbackBase({ manifestPlugins: [], skipAuthProfileRuntime: true, ...params });

beforeEach(() => {
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
});

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

describe("model fallback live selection", () => {
  it("treats LiveSessionModelSwitchError as failover on last candidate (#58496 family)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    // With no fallbacks, the single candidate is also the last one.
    // Previously this would re-throw LiveSessionModelSwitchError, causing
    // the outer retry loop to restart with the overloaded model indefinitely.
    // Now it should surface as a FailoverError instead.
    const err = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
      fallbacksOverride: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Should NOT be a LiveSessionModelSwitchError — the outer retry loop must
    // not restart with the conflicting model.
    expect(err).not.toBeInstanceOf(LiveSessionModelSwitchError);
    expect((err as { reason?: string }).reason).toBe("unknown");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns an unconfigured live switch target to the retry owner (#101676)", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues fallback past a stale switch to an earlier candidate (#58496 family)", async () => {
    const cfg = createModelFallbackConfig("openai/gpt-4.1-mini", [
      "anthropic/claude-haiku-3-5",
      "deepseek/deepseek-chat",
    ]);
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new FailoverError("rate limited", {
          reason: "rate_limit",
          provider: "openai",
          model: "gpt-4.1-mini",
        }),
      )
      .mockRejectedValueOnce(switchError)
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(result.result).toBe("ok");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-chat");
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-4.1-mini", { modelRoutingProvenance: { selectionChanged: false } }],
      ["anthropic", "claude-haiku-3-5", { modelRoutingProvenance: { selectionChanged: false } }],
      ["deepseek", "deepseek-chat", { modelRoutingProvenance: { selectionChanged: true } }],
    ]);
  });

  it.each([false, true])(
    "preserves a later live-session model switch through subsequent failure=%s (#57471)",
    async (failsAfterSwitch) => {
      const cfg = createModelFallbackConfig("openai/gpt-4.1-mini", [
        "anthropic/claude-haiku-3-5",
        "anthropic/claude-sonnet-4-6",
        "openrouter/deepseek-chat",
      ]);
      const switchError = new LiveSessionModelSwitchError({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      const run = vi.fn(async (provider: string, model: string) => {
        if (provider === "openai" && model === "gpt-4.1-mini") {
          throw switchError;
        }
        if (provider === "anthropic" && model === "claude-sonnet-4-6") {
          if (failsAfterSwitch) {
            throw new FailoverError("rate limited", { reason: "rate_limit", provider, model });
          }
          return "ok";
        }
        if (provider === "openrouter" && model === "openrouter/deepseek-chat") {
          return "ok";
        }
        throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
      });
      const onError = vi.fn();

      const result = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
        onError,
      });

      expect(result.result).toBe("ok");
      expect(result.provider).toBe(failsAfterSwitch ? "openrouter" : "anthropic");
      expect(result.model).toBe(
        failsAfterSwitch ? "openrouter/deepseek-chat" : "claude-sonnet-4-6",
      );
      expect(result.attempts).toMatchObject(
        failsAfterSwitch
          ? [{ provider: "anthropic", model: "claude-sonnet-4-6", reason: "rate_limit" }]
          : [],
      );
      expect(onError).toHaveBeenCalledTimes(failsAfterSwitch ? 1 : 0);
      expect(run.mock.calls).toMatchObject([
        [
          "openai",
          "gpt-4.1-mini",
          { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: false } },
        ],
        [
          "anthropic",
          "claude-sonnet-4-6",
          { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: true } },
        ],
        ...(failsAfterSwitch
          ? [
              [
                "openrouter",
                "openrouter/deepseek-chat",
                {
                  isFinalFallbackAttempt: true,
                  modelRoutingProvenance: { selectionChanged: true },
                },
              ],
            ]
          : []),
      ]);
    },
  );

  it("returns runtime-changing live switches to the retry owner before redirecting", async () => {
    const cfg = createModelFallbackConfig("anthropic/claude-haiku-3-5", ["openai/gpt-5.6-luna"]);
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: "codex",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-haiku-3-5",
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "openai" ? "openclaw" : undefined,
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns same-model runtime switches to the retry owner", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
      agentRuntimeOverride: "codex",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        cfg: makeCfg(),
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        resolveAgentHarnessRuntimeOverride: () => "openclaw",
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not redirect stale live-session switch errors back to the current candidate (#58496 family)", async () => {
    const cfg = makeCfg();
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-4.1-mini",
    });
    const run = vi.fn().mockRejectedValueOnce(switchError).mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-3-5");
    expect(result.attempts[0]?.reason).toBe("unknown");
    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-4.1-mini", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-haiku-3-5", { isFinalFallbackAttempt: true }],
    ]);
  });
});
