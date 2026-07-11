import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionModelRef } from "./session-model-ref.js";

function modelConfig(primary: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary } },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("resolveSessionModelRef", () => {
  test("prefers a complete explicit override over runtime identity and current defaults", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        providerOverride: "openrouter",
        modelOverride: "moonshotai/kimi-k2.5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k2.5" });
  });

  test("uses the current agent default instead of stale runtime identity", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      { modelProvider: "openai", model: "gpt-5.4" },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves runtime identity for legacy callers without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-5.4" });
  });

  test("prefers a legacy model-only override over runtime identity without an agent id", () => {
    const resolved = resolveSessionModelRef(modelConfig("anthropic/claude-opus-4-6"), {
      modelOverride: "claude-haiku-4-5",
      modelProvider: "openai",
      model: "gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("resolves a legacy model-only override under the current default provider", () => {
    const resolved = resolveSessionModelRef(
      modelConfig("anthropic/claude-opus-4-6"),
      {
        modelOverride: "claude-haiku-4-5",
        modelProvider: "openai",
        model: "gpt-5.4",
      },
      "main",
    );

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("uses the configured subagent model for spawned session projections", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          subagents: { model: { primary: "openai/gpt-5.6-luna" } },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect(resolveSessionModelRef(cfg, { spawnDepth: 1 }, "main")).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
  });

  test("keeps explicit child overrides ahead of configured subagent defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          subagents: { model: { primary: "openai/gpt-5.6-luna" } },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect(
      resolveSessionModelRef(
        cfg,
        {
          spawnDepth: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-7",
        },
        "main",
      ),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-7" });
  });

  test("does not retarget model-locked subagent sessions", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          subagents: { model: { primary: "openai/gpt-5.6-luna" } },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect(
      resolveSessionModelRef(cfg, { modelSelectionLocked: true, subagentRole: "leaf" }, "main"),
    ).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });
});
