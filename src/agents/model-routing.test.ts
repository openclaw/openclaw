import { describe, expect, it } from "vitest";

import type { ClawdbrainConfig } from "../config/config.js";
import { resolveModelRoutingSelection } from "./model-routing.js";

describe("model-routing", () => {
  it("returns base selection when routing is disabled", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRouting: { enabled: false },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });

    expect(selection.mode).toBe("off");
    expect(selection.executor).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("routes tiered mode to the configured tier model", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            models: {
              remote: "openai/gpt-4o",
            },
            defaultPolicy: {
              mode: "tiered",
              tier: "remote",
            },
          },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });

    expect(selection.mode).toBe("tiered");
    expect(selection.executor).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("routes hybrid mode to planner + executor", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            models: {
              planner: "anthropic/claude-opus-4-5",
              localLarge: "ollama/qwen2.5:32b",
            },
            intents: {
              "cli.agent": {
                mode: "hybrid",
                executorTier: "local-large",
              },
            },
          },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });

    expect(selection.mode).toBe("hybrid");
    expect(selection.planner).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
    expect(selection.executor).toEqual({ provider: "ollama", model: "qwen2.5:32b" });
  });

  it("respects an existing session override by default", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            models: {
              localSmall: "ollama/llama3:8b",
            },
            defaultPolicy: { mode: "tiered", tier: "local-small" },
          },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
      sessionHasModelOverride: true,
    });

    expect(selection.mode).toBe("off");
    expect(selection.executor).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("can override an existing session override when configured", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRouting: {
            enabled: true,
            models: {
              localSmall: "ollama/llama3:8b",
            },
            defaultPolicy: {
              mode: "tiered",
              tier: "local-small",
              respectSessionOverride: false,
            },
          },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
      sessionHasModelOverride: true,
    });

    expect(selection.mode).toBe("tiered");
    expect(selection.executor).toEqual({ provider: "ollama", model: "llama3:8b" });
  });

  it("resolves modelRouting models via aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "ollama/llama3:8b": { alias: "tiny" },
          },
          modelRouting: {
            enabled: true,
            models: { localSmall: "tiny" },
            defaultPolicy: { mode: "tiered", tier: "local-small" },
          },
        },
      },
    } satisfies ClawdbrainConfig;

    const selection = resolveModelRoutingSelection({
      cfg,
      intent: "cli.agent",
      base: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });

    expect(selection.executor).toEqual({ provider: "ollama", model: "llama3:8b" });
  });
});
