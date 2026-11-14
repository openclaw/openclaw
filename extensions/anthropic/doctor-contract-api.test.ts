import type { OpenClawConfig as Config } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const opus = "anthropic/claude-opus-5";
const sonnet = "anthropic/claude-sonnet-5";
const cli = { agentRuntime: { id: "claude-cli" } };
const pinned = { [opus]: { ...cli, alias: "Opus" }, "openai/gpt-5.2": {} };
type Defaults = NonNullable<NonNullable<Config["agents"]>["defaults"]>;
// Native login (#129052) seeded pinned rows but no wildcard or auth profile.
function config(defaults: Partial<Defaults> = {}, extra: Partial<Config> = {}): Config {
  const model = { primary: opus, fallbacks: ["openai/gpt-5.2"] };
  return { agents: { defaults: { model, models: pinned, ...defaults } }, ...extra };
}
function provider(apiKey?: string, agentRuntime?: { id: string }): Config {
  return config(
    {},
    { models: { providers: { anthropic: { baseUrl: "", models: [], apiKey, agentRuntime } } } },
  );
}
function models(entries: Defaults["models"], model: Defaults["model"] = opus) {
  return config({ models: entries, model });
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

it.each<[string, Config]>([
  ["earlier sign-in", config()],
  ["retired provider marker", provider("anthropic:claude-cli")],
  ["string default model", config({ model: opus })],
])("repairs %s idempotently", (_name, cfg) => {
  const result = normalizeCompatibilityConfig({ cfg });
  expect(result.changes).toHaveLength(1);
  expect(result.config.agents?.defaults).toEqual({
    ...cfg.agents?.defaults,
    models: { ...pinned, "anthropic/*": cli },
  });
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
});

it.each<[string, Config, string?]>([
  ["authored wildcard runtime", models({ "anthropic/*": { agentRuntime: { id: "openclaw" } } })],
  ["authored wildcard alias", models({ "anthropic/*": { alias: "Claude" } })],
  ["empty config", {}],
  // The API primary's credential may live only in the auth store, invisible to repair.
  [
    "API primary with CLI fallback",
    models({ [opus]: { alias: "Opus" }, [sonnet]: cli }, { primary: opus, fallbacks: [sonnet] }),
  ],
  ["non-Anthropic primary", models({ [opus]: cli, "openai/gpt-5.2": {} }, "openai/gpt-5.2")],
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
  ["process API key", config(), "placeholder"],
])("leaves %s unchanged", (_name, cfg, apiKey) => {
  vi.stubEnv("ANTHROPIC_API_KEY", apiKey ?? "");
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});
