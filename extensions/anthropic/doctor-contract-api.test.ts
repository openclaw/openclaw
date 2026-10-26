import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const opus = "anthropic/claude-opus-5";
const sonnet = "anthropic/claude-sonnet-5";
const cli = { agentRuntime: { id: "claude-cli" } };
const pinned = {
  [opus]: { ...cli, alias: "Opus" },
  "anthropic/claude-sonnet-4-6": cli,
  "openai/gpt-5.2": {},
};
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
// Native login (#129052) seeded pinned rows but no wildcard or auth profile.
function config(
  defaults: Partial<Defaults> = {},
  extra: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  const model = { primary: opus, fallbacks: ["openai/gpt-5.2"] };
  return { agents: { defaults: { model, models: pinned, ...defaults } }, ...extra };
}
function provider(apiKey?: string, agentRuntime?: { id: string }): OpenClawConfig {
  return config(
    {},
    { models: { providers: { anthropic: { baseUrl: "", models: [], apiKey, agentRuntime } } } },
  );
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

it("adds the Claude CLI wildcard to an earlier sign-in, idempotently", () => {
  const cfg = config();
  const result = normalizeCompatibilityConfig({ cfg });
  expect(result.changes).toEqual([
    'agents.defaults.models["anthropic/*"]: added the claude-cli runtime so Claude models not seeded at Claude CLI sign-in run through Claude Code instead of failing without an Anthropic API key.',
  ]);
  expect(result.config.agents?.defaults).toEqual({
    ...cfg.agents?.defaults,
    models: { ...pinned, "anthropic/*": cli },
  });
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
});

it.each<[string, OpenClawConfig]>([
  ["retired provider marker", provider("anthropic:claude-cli")],
  ["string default model", config({ model: opus })],
])("repairs a %s", (_name, cfg) => {
  expect(normalizeCompatibilityConfig({ cfg }).changes).toHaveLength(1);
});

it.each<[string, OpenClawConfig]>([
  [
    "authored wildcard runtime",
    config({ models: { ...pinned, "anthropic/*": { agentRuntime: { id: "openclaw" } } } }),
  ],
  [
    "authored wildcard alias",
    config({ models: { ...pinned, "anthropic/*": { alias: "Claude" } } }),
  ],
  ["empty config", {}],
  [
    "non-CLI entries",
    config({
      model: opus,
      models: {
        [opus]: {},
        [sonnet]: { agentRuntime: { id: "openclaw" } },
        "claude-cli/claude-opus-5": {},
      },
    }),
  ],
  // The API primary's credential may live only in the auth store, invisible to repair.
  [
    "API primary with CLI fallback",
    config({
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: [sonnet] },
      models: { "anthropic/claude-opus-4-6": { alias: "Opus" }, [sonnet]: cli },
    }),
  ],
  [
    "non-Anthropic primary",
    config({ model: "openai/gpt-5.2", models: { [opus]: cli, "openai/gpt-5.2": {} } }),
  ],
  [
    "auth profile",
    config(
      {},
      { auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } } },
    ),
  ],
  ["provider API key", provider("sk-ant-placeholder")],
  ["config env key", config({}, { env: { vars: { ANTHROPIC_API_KEY: "placeholder" } } })],
  ["provider runtime", provider(undefined, { id: "openclaw" })],
])("leaves %s unchanged", (_name, cfg) => {
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});

it("preserves a sign-in when the process has an Anthropic API key", () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "placeholder");
  const cfg = config();
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});
