// Anthropic tests cover the plugin-owned Doctor repair for Claude CLI sign-ins.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const CLAUDE_CLI = { agentRuntime: { id: "claude-cli" } };

// Shape written by Claude CLI sign-in between native login (#129052) and the
// `anthropic/*` entry: seeded catalog rows pinned to Claude CLI, no auth profile.
function signedInConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-5", fallbacks: ["openai/gpt-5.2"] },
        models: {
          "anthropic/claude-opus-5": { ...CLAUDE_CLI, alias: "Opus" },
          "anthropic/claude-sonnet-4-6": CLAUDE_CLI,
          "openai/gpt-5.2": {},
        },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Anthropic Doctor contract", () => {
  it("adds the Claude CLI wildcard to an earlier Claude CLI sign-in", () => {
    const cfg = signedInConfig();
    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      'agents.defaults.models["anthropic/*"]: added the claude-cli runtime so Claude models not seeded at Claude CLI sign-in run through Claude Code instead of failing without an Anthropic API key.',
    ]);
    expect(result.config.agents?.defaults).toEqual({
      ...cfg.agents?.defaults,
      models: { ...cfg.agents?.defaults?.models, "anthropic/*": CLAUDE_CLI },
    });
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("keeps a retired Claude CLI provider marker eligible", () => {
    const cfg = signedInConfig({
      models: {
        providers: { anthropic: { baseUrl: "", apiKey: "anthropic:claude-cli", models: [] } },
      },
    });
    expect(normalizeCompatibilityConfig({ cfg }).changes).toHaveLength(1);
  });

  it("accepts a string default model", () => {
    const cfg = signedInConfig();
    cfg.agents!.defaults!.model = "anthropic/claude-opus-5";
    expect(normalizeCompatibilityConfig({ cfg }).changes).toHaveLength(1);
  });

  it.each([
    [
      "an existing wildcard naming another runtime",
      { "anthropic/*": { agentRuntime: { id: "openclaw" } } },
    ],
    ["an existing wildcard without a runtime", { "anthropic/*": { alias: "Claude" } }],
  ])("leaves %s unchanged", (_name, extra) => {
    const cfg = signedInConfig();
    cfg.agents!.defaults!.models = { ...cfg.agents?.defaults?.models, ...extra };
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it.each<[string, OpenClawConfig]>([
    ["an empty config", {}],
    [
      "Anthropic entries without the Claude CLI runtime",
      {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-5",
            models: {
              "anthropic/claude-opus-5": {},
              "anthropic/claude-sonnet-5": { agentRuntime: { id: "openclaw" } },
              "claude-cli/claude-opus-5": {},
            },
          },
        },
      },
    ],
    [
      // Documented API primary with a Claude CLI fallback; its credential may
      // live only in the auth store, which config repair cannot see.
      "an API default model with a Claude CLI fallback",
      {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-5"],
            },
            models: {
              "anthropic/claude-opus-4-6": { alias: "Opus" },
              "anthropic/claude-sonnet-5": CLAUDE_CLI,
            },
          },
        },
      },
    ],
    [
      "a non-Anthropic default model",
      signedInConfig({
        agents: {
          defaults: {
            model: "openai/gpt-5.2",
            models: { "anthropic/claude-opus-5": CLAUDE_CLI, "openai/gpt-5.2": {} },
          },
        },
      }),
    ],
    [
      "an Anthropic auth profile",
      signedInConfig({
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } },
      }),
    ],
    [
      "an Anthropic provider API key",
      signedInConfig({
        models: {
          providers: { anthropic: { baseUrl: "", apiKey: "sk-ant-placeholder", models: [] } },
        },
      }),
    ],
    [
      "an Anthropic key in config env",
      signedInConfig({ env: { vars: { ANTHROPIC_API_KEY: "placeholder" } } }),
    ],
    [
      "a provider-level runtime",
      signedInConfig({
        models: {
          providers: { anthropic: { baseUrl: "", models: [], agentRuntime: { id: "openclaw" } } },
        },
      }),
    ],
  ])("leaves %s unchanged", (_name, cfg) => {
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });

  it("leaves a sign-in unchanged when the process has an Anthropic API key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "placeholder");
    const cfg = signedInConfig();
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });
});
