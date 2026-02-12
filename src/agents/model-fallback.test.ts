import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import {
  __recordModelFailureForTest,
  getModelCooldownSnapshot,
  isModelCoolingDown,
  parseRetryAfterMs,
  resetModelCooldowns,
  resetProviderBreakers,
  runWithCodingModelFallback,
  runWithModelFallback,
} from "./model-fallback.js";

function makeCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("runWithModelFallback", () => {
  beforeEach(() => {
    resetProviderBreakers();
    resetModelCooldowns();
  });

  it("does not fall back on non-auth errors", async () => {
    const cfg = makeCfg();
    const run = vi.fn().mockRejectedValueOnce(new Error("bad request")).mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("bad request");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps thinking model pinned when auto-pick is disabled", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openrouter/qwen/qwen3-next-80b-a3b-instruct:free",
            fallbacks: ["openai-codex/gpt-5.1-codex-mini"],
          },
          modelByComplexity: {
            autoPickFromPool: false,
          },
        },
      },
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("429 too many requests"), { status: 429 }));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openrouter",
        model: "qwen/qwen3-next-80b-a3b-instruct:free",
        run,
      }),
    ).rejects.toThrow("429 too many requests");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("openrouter");
  });

  it("forces configured thinking model even when runtime requests another provider", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.2-codex",
            fallbacks: ["github-copilot/gpt-5.1-codex-mini"],
          },
          modelByComplexity: {
            autoPickFromPool: false,
          },
        },
      },
    });

    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "github-copilot",
      model: "gpt-5.1-codex-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(["openai-codex", "gpt-5.2-codex"]);
  });

  it("treats unknown-model errors as failover and continues to next candidate", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.1-codex",
            fallbacks: ["openai-codex/gpt-5.1-codex-mini"],
          },
        },
      },
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unknown model: openai-codex/gpt-5.1-codex"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai-codex",
      model: "gpt-5.1-codex",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.1-codex-mini");
  });

  it("keeps coding model pinned when coding selector is explicitly set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openrouter/qwen/qwen3-next-80b-a3b-instruct:free",
          },
          codingModel: {
            primary: "openrouter/qwen/qwen3-coder:free",
            fallbacks: ["openai-codex/gpt-5.1-codex-mini"],
          },
        },
      },
    });

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("429 too many requests"), { status: 429 }));

    await expect(
      runWithCodingModelFallback({
        cfg,
        run,
      }),
    ).rejects.toThrow("429 too many requests");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("openrouter");
    expect(run.mock.calls[0]?.[1]).toBe("qwen/qwen3-coder:free");
  });

  it("falls back on auth errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 401 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("skips a model in cooldown across runs and re-enables after cooldown expires", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
        },
      },
    });

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    // First run: primary hits rate limit, fallback succeeds.
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("429 too many requests"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const first = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(first.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");

    // Second run inside cooldown: should skip openai/gpt-4.1-mini and go straight to fallback.
    run.mockClear();
    now.mockReturnValue(2_000);
    run.mockResolvedValueOnce("ok2");

    const second = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(second.result).toBe("ok2");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("anthropic");
    expect(run.mock.calls[0]?.[1]).toBe("claude-haiku-3-5");

    // After cooldown: primary should be attempted again.
    run.mockClear();
    now.mockReturnValue(1_000 + 61_000);
    run.mockResolvedValueOnce("ok3");

    const third = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });
    expect(third.result).toBe("ok3");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("openai");
    expect(run.mock.calls[0]?.[1]).toBe("gpt-4.1-mini");
  });

  it("does not put auth-failing models in cooldown", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5.2-codex",
            fallbacks: ["openai/gpt-5.1"],
          },
        },
      },
    });

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);

    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Copilot token exchange failed"), { status: 403 }),
      )
      .mockResolvedValueOnce("ok-fallback");

    const first = await runWithModelFallback({
      cfg,
      provider: "github-copilot",
      model: "gpt-5.2-codex",
      run,
    });
    expect(first.result).toBe("ok-fallback");
    expect(run).toHaveBeenCalledTimes(2);

    run.mockClear();
    now.mockReturnValue(20_000);
    run
      .mockRejectedValueOnce(
        Object.assign(new Error("Copilot token exchange failed"), { status: 403 }),
      )
      .mockResolvedValueOnce("ok-still-fallback");

    const second = await runWithModelFallback({
      cfg,
      provider: "github-copilot",
      model: "gpt-5.2-codex",
      run,
    });
    expect(second.result).toBe("ok-still-fallback");
    // Primary is retried on each run (auth should not quarantine the model).
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(["github-copilot", "gpt-5.2-codex"]);
    expect(run.mock.calls[1]).toEqual(["openai", "gpt-5.1"]);

    now.mockRestore();
  });

  it("falls back on 402 payment required", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("payment required"), { status: 402 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("forces a probe on the last candidate when provider breaker is open", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });

    const runFail = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("upstream unavailable"), { status: 500 }));

    // Trip provider breaker (threshold: 5).
    for (let i = 0; i < 5; i += 1) {
      await expect(
        runWithModelFallback({
          cfg,
          provider: "openai",
          model: "gpt-4.1-mini",
          run: runFail,
        }),
      ).rejects.toThrow();
    }

    const runSuccess = vi.fn().mockResolvedValue("ok-after-forced-probe");
    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run: runSuccess,
    });

    expect(result.result).toBe("ok-after-forced-probe");
    expect(runSuccess).toHaveBeenCalledTimes(1);
  });

  it("falls back on billing errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "LLM request rejected: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        ),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on credential validation errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('No credentials found for profile "anthropic:default".'))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("skips providers when all profiles are in cooldown", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-test-${crypto.randomUUID()}`;
    const profileId = `${provider}:default`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider,
          key: "test-key",
        },
      },
      usageStats: {
        [profileId]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId, modelId) => {
      if (providerId === "fallback") {
        return "ok";
      }
      throw new Error(`unexpected provider: ${providerId}/${modelId}`);
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([["fallback", "ok-model"]]);
      expect(result.attempts[0]?.reason).toBe("rate_limit");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not skip when any profile is available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const provider = `cooldown-mixed-${crypto.randomUUID()}`;
    const profileA = `${provider}:a`;
    const profileB = `${provider}:b`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileA]: {
          type: "api_key",
          provider,
          key: "key-a",
        },
        [profileB]: {
          type: "api_key",
          provider,
          key: "key-b",
        },
      },
      usageStats: {
        [profileA]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: `${provider}/m1`,
            fallbacks: ["fallback/ok-model"],
          },
        },
      },
    });
    const run = vi.fn().mockImplementation(async (providerId) => {
      if (providerId === provider) {
        return "ok";
      }
      return "unexpected";
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider,
        model: "m1",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      expect(run.mock.calls).toEqual([[provider, "m1"]]);
      expect(result.attempts).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not append configured primary when fallbacksOverride is set", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockImplementation(() => Promise.reject(Object.assign(new Error("nope"), { status: 401 })));

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: ["anthropic/claude-haiku-3-5"],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run.mock.calls).toEqual([
      ["anthropic", "claude-opus-4-5"],
      ["anthropic", "claude-haiku-3-5"],
    ]);
  });

  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    const res = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "anthropic") {
          throw Object.assign(new Error("nope"), { status: 401 });
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as OpenClawConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([{ provider: "anthropic", model: "claude-opus-4-5" }]);
  });

  it("defaults provider/model when missing (regression #946)", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    const result = await runWithModelFallback({
      cfg,
      provider: undefined as unknown as string,
      model: undefined as unknown as string,
      run: async (provider, model) => {
        calls.push({ provider, model });
        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("falls back on missing API key errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("No API key found for profile openai."))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on lowercase credential errors", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("no api key found for profile openai"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on timeout abort errors", async () => {
    const cfg = makeCfg();
    const timeoutCause = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError", cause: timeoutCause }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on abort errors with timeout reasons", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError", reason: "deadline exceeded" }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back when message says aborted but error is a timeout", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("request aborted"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("falls back on provider abort errors with request-aborted messages", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Request was aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[1]).toBe("claude-haiku-3-5");
  });

  it("does not fall back on user aborts", async () => {
    const cfg = makeCfg();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce("ok");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("aborted");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("appends the configured primary as a last fallback", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    });
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b:free",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
  });

  it("auto-populates fallbacks from allowlist when no explicit fallbacks configured", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            // no fallbacks
          },
          models: {
            "openai/gpt-4.1-mini": { enabled: true },
            "anthropic/claude-haiku-3-5": { enabled: true },
            "google/gemini-2.5-flash": { enabled: true },
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];
    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      calls.push({ provider, model });
      if (provider === "google" && model === "gemini-2.5-flash") {
        return "ok";
      }
      throw Object.assign(new Error("auth error"), { status: 401 });
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    // Primary first, then allowlist models (primary deduplicated), then configured primary appended
    expect(calls.some((c) => c.provider === "anthropic" && c.model === "claude-haiku-3-5")).toBe(
      true,
    );
    expect(calls.some((c) => c.provider === "google" && c.model === "gemini-2.5-flash")).toBe(true);
  });

  it("does not auto-populate from allowlist when explicit fallbacks exist", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
          models: {
            "openai/gpt-4.1-mini": { enabled: true },
            "anthropic/claude-haiku-3-5": { enabled: true },
            "google/gemini-2.5-flash": { enabled: true },
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];
    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      calls.push({ provider, model });
      if (provider === "anthropic" && model === "claude-haiku-3-5") {
        return "ok";
      }
      throw Object.assign(new Error("auth error"), { status: 401 });
    });

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    // Should NOT have tried google model since explicit fallbacks are configured
    expect(calls.every((c) => c.provider !== "google")).toBe(true);
  });

  it("does not auto-populate from allowlist when fallbacksOverride is empty array", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
          models: {
            "openai/gpt-4.1-mini": { enabled: true },
            "anthropic/claude-haiku-3-5": { enabled: true },
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("fail");
        },
      }),
    ).rejects.toThrow("fail");

    // Only primary should have been tried — fallbacksOverride=[] disables everything
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });

  it("health-aware ordering prioritizes healthy providers over cooldown ones", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    const cooldownProvider = `cooldown-sort-${crypto.randomUUID()}`;
    const healthyProvider = `healthy-sort-${crypto.randomUUID()}`;
    const cooldownProfileId = `${cooldownProvider}:default`;
    const healthyProfileId = `${healthyProvider}:default`;

    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [cooldownProfileId]: {
          type: "api_key",
          provider: cooldownProvider,
          key: "test-key-1",
        },
        [healthyProfileId]: {
          type: "api_key",
          provider: healthyProvider,
          key: "test-key-2",
        },
      },
      usageStats: {
        [cooldownProfileId]: {
          cooldownUntil: Date.now() + 60_000,
        },
      },
    };

    saveAuthProfileStore(store, tempDir);

    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
          },
          models: {
            "openai/gpt-4.1-mini": { enabled: true },
            // cooldown provider listed first in allowlist
            [`${cooldownProvider}/m1`]: { enabled: true },
            // healthy provider listed second
            [`${healthyProvider}/m2`]: { enabled: true },
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];
    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      calls.push({ provider, model });
      if (provider === healthyProvider) {
        return "ok";
      }
      throw Object.assign(new Error("auth error"), { status: 401 });
    });

    try {
      const result = await runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        agentDir: tempDir,
        run,
      });

      expect(result.result).toBe("ok");
      // Healthy provider should be tried before the cooldown one (health-aware sorting)
      const healthyIdx = calls.findIndex((c) => c.provider === healthyProvider);
      const cooldownIdx = calls.findIndex((c) => c.provider === cooldownProvider);
      // cooldown provider may be skipped entirely or tried after healthy
      if (cooldownIdx >= 0) {
        expect(healthyIdx).toBeLessThan(cooldownIdx);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not produce extra candidates with empty allowlist", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            // no fallbacks, no models allowlist
          },
        },
      },
    });

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("fail");
        },
      }),
    ).rejects.toThrow("fail");

    // Only the primary (and configured primary appended, which is same = deduplicated)
    expect(calls).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses 'quota will reset after Xh Ym Zs' format", () => {
    const msg =
      "Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 4h37m20s.";
    expect(parseRetryAfterMs(msg)).toBe((4 * 3600 + 37 * 60 + 20) * 1000);
  });

  it("parses hours + minutes without seconds", () => {
    expect(parseRetryAfterMs("quota will reset after 2h15m")).toBe((2 * 3600 + 15 * 60) * 1000);
  });

  it("parses minutes + seconds without hours", () => {
    expect(parseRetryAfterMs("retry after 5m30s")).toBe((5 * 60 + 30) * 1000);
  });

  it("parses seconds only", () => {
    expect(parseRetryAfterMs("retry after 120s")).toBe(120_000);
  });

  it("parses plain Retry-After header style", () => {
    expect(parseRetryAfterMs("Retry-After: 3600")).toBe(3_600_000);
  });

  it("returns 0 for messages without retry hint", () => {
    expect(parseRetryAfterMs("some random error")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseRetryAfterMs("")).toBe(0);
  });
});

describe("recordModelFailure with retry-after hint", () => {
  beforeEach(() => {
    resetProviderBreakers();
    resetModelCooldowns();
  });

  it("uses upstream retry-after duration when present", () => {
    __recordModelFailureForTest({
      provider: "google-antigravity",
      model: "claude-opus-4-6-thinking",
      reason: "rate_limit",
      errorMessage: "Your quota will reset after 4h37m20s.",
    });

    const snapshot = getModelCooldownSnapshot();
    expect(snapshot).toHaveLength(1);
    const entry = snapshot[0];
    // Should use the parsed 4h37m20s = 16640s = 16640000ms (not the default 60s)
    expect(entry.remainingMs).toBeGreaterThan(60_000);
    expect(entry.remainingMs).toBeLessThanOrEqual(4 * 3600 * 1000 + 38 * 60 * 1000);
  });

  it("falls back to default exponential backoff when no retry hint", () => {
    __recordModelFailureForTest({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      reason: "rate_limit",
    });

    const snapshot = getModelCooldownSnapshot();
    expect(snapshot).toHaveLength(1);
    // Default: 60s base for first failure
    expect(snapshot[0].remainingMs).toBeLessThanOrEqual(61_000);
  });

  it("caps retry-after at 6 hours", () => {
    __recordModelFailureForTest({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      reason: "rate_limit",
      errorMessage: "Your quota will reset after 24h0m0s.",
    });

    const snapshot = getModelCooldownSnapshot();
    expect(snapshot).toHaveLength(1);
    // Should be capped at 6 hours = 21600000ms
    expect(snapshot[0].remainingMs).toBeLessThanOrEqual(6 * 3600 * 1000 + 1000);
  });

  it("model enters cooldown and is detected", () => {
    __recordModelFailureForTest({
      provider: "google-antigravity",
      model: "gpt-oss-120b-medium",
      reason: "rate_limit",
      errorMessage: "retry after 300s",
    });

    expect(
      isModelCoolingDown({ provider: "google-antigravity", model: "gpt-oss-120b-medium" }),
    ).toBe(true);
    expect(isModelCoolingDown({ provider: "google-antigravity", model: "other-model" })).toBe(
      false,
    );
  });
});
