import { expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelDefinition, providerEntry } from "./model-auth.fixtures.test-support.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-resolve.js";

const context = {
  manifestPlugins: [{ providers: ["anthropic", "openai", "openrouter"] }],
  allowPluginNormalization: false,
  defaultProvider: "openai",
};
const smallModel = { provider: "openai", model: "gpt-4o-mini" };

function configWithAliases(
  models: AgentDefaultsConfig["models"],
  model?: string,
  providers?: NonNullable<OpenClawConfig["models"]>["providers"],
): OpenClawConfig {
  return {
    agents: { defaults: { models, ...(model ? { model } : {}) } },
    ...(providers ? { models: { providers } } : {}),
  };
}

function resolver(cfg: OpenClawConfig, manifestPlugins = context.manifestPlugins) {
  const aliasIndex = buildModelAliasIndex({ ...context, cfg, manifestPlugins });
  const params = { ...context, aliasIndex };
  return (raw: string, includeConfig = false) =>
    resolveModelRefFromString({ ...params, ...(includeConfig ? { cfg } : {}), raw });
}

function resolveConfiguredRefForTest(cfg: OpenClawConfig) {
  return resolveConfiguredModelRef({
    ...context,
    cfg,
    defaultModel: "gpt-4o-mini",
  });
}

it.each([
  ["openai", "gpt-4o-mini"],
  ["anthropic", "claude-sonnet-4-6"],
])("keeps explicit %s/%s authoritative with default provider openai", (provider, model) => {
  const raw = `${provider}/${model}`;
  const resolve = resolver(configWithAliases({ [`openrouter/${raw}`]: { alias: raw } }));
  expect(resolve(raw)?.ref).toEqual({ provider, model });
  expect(resolve(`openrouter/${raw}`)?.ref).toEqual({ provider: "openrouter", model: raw });
});

it.each(["config", "manifest"])(
  "retains %s provider authority in a config-free index",
  (source) => {
    const cfg = configWithAliases(
      { "openai/gpt-4o-mini": { alias: "acme/small" } },
      undefined,
      source === "config" ? { acme: providerEntry("https://acme.example/v1") } : undefined,
    );
    const resolve = resolver(
      cfg,
      source === "manifest" ? [{ providers: ["acme"] }] : context.manifestPlugins,
    );
    expect(resolve("acme/small")?.ref).toEqual({ provider: "acme", model: "small" });
  },
);

it.each([
  ["openai/anthropic/small@work", "openai/gpt-4o-mini", "anthropic/small@work"],
  ["openai/gpt-4o-mini@work", "openrouter/openai/gpt-4o-mini", "openai/gpt-4o-mini"],
])("resolves profile-qualified primary %s in its own provider", (raw, target, alias) => {
  const cfg = configWithAliases({ [target]: { alias } }, raw);
  expect(resolver(cfg)(raw)?.ref).toEqual(smallModel);
  expect(resolveConfiguredRefForTest(cfg)).toEqual(smallModel);
});

it("resolves provider-qualified aliases without cross-provider collisions", () => {
  const resolve = resolver(
    configWithAliases({
      "local-a/small": { alias: "Local" },
      "local-b/large": { alias: "Local" },
    }),
  );
  expect(resolve("local-a/Local")).toEqual({
    ref: { provider: "local-a", model: "small" },
    alias: "Local",
  });
  expect(resolve("local-b/LOCAL")).toEqual({
    ref: { provider: "local-b", model: "large" },
    alias: "Local",
  });
});

it.each([
  { raw: "fixture/reasoner", alias: "reasoner", expected: "reasoner" },
  { raw: "fixture/reasoner@work", alias: "fixture/reasoner", expected: "reasoner" },
  { raw: "reasoner", alias: "reasoner", expected: "backup" },
  { raw: "fixture/friendly", alias: "friendly", expected: "backup" },
])(
  "keeps exact configured model identity for $raw with alias $alias",
  ({ raw, alias, expected }) => {
    const cfg = configWithAliases({ "fixture/backup": { alias } }, raw, {
      fixture: providerEntry("http://127.0.0.1:8080/v1", {
        api: "openai-completions",
        models: ["reasoner", "backup"].map((id) => modelDefinition(id)),
      }),
    });
    expect(resolveConfiguredRefForTest(cfg)).toEqual({ provider: "fixture", model: expected });
    expect(resolver(cfg)(raw, true)?.ref).toEqual({ provider: "fixture", model: expected });
  },
);
