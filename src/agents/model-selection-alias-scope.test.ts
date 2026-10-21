import { expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
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

function configWithAliases(models: AgentDefaultsConfig["models"], model?: string): OpenClawConfig {
  return { agents: { defaults: { models, ...(model ? { model } : {}) } } };
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
  {
    raw: "openai/gpt-4o-mini",
    expected: { provider: "openai", model: "gpt-4o-mini" },
  },
  {
    raw: "anthropic/claude-sonnet-4-6",
    expected: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
])("keeps explicit $raw authoritative with default provider openai", ({ raw, expected }) => {
  const resolve = resolver(configWithAliases({ [`openrouter/${raw}`]: { alias: raw } }));
  expect(resolve(raw)?.ref).toEqual(expected);
  expect(resolve(`openrouter/${raw}`)?.ref).toEqual({ provider: "openrouter", model: raw });
});

it.each(["config", "manifest"])(
  "retains %s provider authority in a config-free index",
  (source) => {
    const cfg: OpenClawConfig = {
      ...(source === "config"
        ? { models: { providers: { acme: { baseUrl: "https://acme.example/v1", models: [] } } } }
        : {}),
      ...configWithAliases({ "openai/gpt-4o-mini": { alias: "acme/small" } }),
    };
    const resolve = resolver(
      cfg,
      source === "manifest" ? [{ providers: ["acme"] }] : context.manifestPlugins,
    );
    expect(resolve("acme/small")?.ref).toEqual({ provider: "acme", model: "small" });
  },
);

it.each([
  {
    raw: "openai/anthropic/small@work",
    target: "openai/gpt-4o-mini",
    alias: "anthropic/small@work",
  },
  {
    raw: "openai/gpt-4o-mini@work",
    target: "openrouter/openai/gpt-4o-mini",
    alias: "openai/gpt-4o-mini",
  },
])("resolves profile-qualified primary $raw in its own provider", ({ raw, target, alias }) => {
  const cfg = configWithAliases({ [target]: { alias } }, raw);
  expect(resolver(cfg)(raw)?.ref).toEqual(smallModel);
  expect(resolveConfiguredRefForTest(cfg)).toEqual(smallModel);
});

it("resolves provider-qualified aliases without cross-provider collisions", () => {
  const resolve = resolver(
    configWithAliases({
      "lmstudio-moe/qwen3.6-35b-a3b": { alias: "Local" },
      "lmstudio-dense/qwen3.6-27b": { alias: "Local" },
    }),
  );
  expect(resolve("lmstudio-moe/Local")).toEqual({
    ref: { provider: "lmstudio-moe", model: "qwen3.6-35b-a3b" },
    alias: "Local",
  });
  expect(resolve("lmstudio-dense/LOCAL")).toEqual({
    ref: { provider: "lmstudio-dense", model: "qwen3.6-27b" },
    alias: "Local",
  });
});

it.each([
  { raw: "fixture/reasoner", alias: "reasoner", expected: "reasoner" },
  { raw: "fixture/reasoner@work", alias: "reasoner", expected: "reasoner" },
  { raw: "fixture/reasoner", alias: "fixture/reasoner", expected: "reasoner" },
  { raw: "fixture/reasoner@work", alias: "fixture/reasoner", expected: "reasoner" },
  { raw: "reasoner", alias: "reasoner", expected: "backup" },
  { raw: "fixture/friendly", alias: "friendly", expected: "backup" },
])(
  "keeps exact configured model identity for $raw with alias $alias",
  ({ raw, alias, expected }) => {
    const cfg: OpenClawConfig = {
      ...configWithAliases({ "fixture/backup": { alias } }, raw),
      models: {
        providers: {
          fixture: {
            baseUrl: "http://127.0.0.1:8080/v1",
            api: "openai-completions",
            models: ["reasoner", "backup"].map((id) =>
              modelDefinition(id, { reasoning: false, contextWindow: 32768, maxTokens: 4096 }),
            ),
          },
        },
      },
    };
    expect(resolveConfiguredRefForTest(cfg)).toEqual({ provider: "fixture", model: expected });
    expect(resolver(cfg)(raw, true)?.ref).toEqual({ provider: "fixture", model: expected });
  },
);
