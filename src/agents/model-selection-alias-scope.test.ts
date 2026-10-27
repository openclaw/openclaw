import { expect, it } from "vitest";
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
const ref = (provider: string, model: string) => ({ provider, model });
function config(aliases: Record<string, string>, model?: string): OpenClawConfig {
  const models = Object.fromEntries(
    Object.entries(aliases).map(([key, alias]) => [key, { alias }]),
  );
  return { agents: { defaults: { models, model } } };
}
function resolver(cfg: OpenClawConfig, manifestPlugins = context.manifestPlugins) {
  const aliasIndex = buildModelAliasIndex({ ...context, cfg, manifestPlugins });
  return (raw: string, includeConfig = false) =>
    resolveModelRefFromString({
      ...context,
      aliasIndex,
      raw,
      ...(includeConfig ? { cfg } : {}),
    });
}
function checkPrimary(
  cfg: OpenClawConfig,
  raw: string,
  expected: ReturnType<typeof ref>,
  includeConfig = false,
) {
  expect(resolver(cfg)(raw, includeConfig)?.ref).toEqual(expected);
  expect(resolveConfiguredModelRef({ ...context, cfg, defaultModel: "gpt-4o-mini" })).toEqual(
    expected,
  );
}

it.each(["openai", "anthropic"])(
  "keeps explicit %s refs ahead of colliding aliases",
  (provider) => {
    const raw = `${provider}/small`;
    const resolve = resolver(config({ [`openrouter/${raw}`]: raw }));
    expect(resolve(raw)?.ref).toEqual(ref(provider, "small"));
    expect(resolve(`openrouter/${raw}`)?.ref).toEqual(ref("openrouter", raw));
  },
);

it.each(["config", "manifest"])("retains %s authority in a config-free index", (source) => {
  const cfg = config({ "openai/gpt-4o-mini": "acme/small" });
  if (source === "config") {
    cfg.models = { providers: { acme: providerEntry("https://acme.example/v1") } };
  }
  const resolve = resolver(
    cfg,
    source === "manifest" ? [{ providers: ["acme"] }] : context.manifestPlugins,
  );
  expect(resolve("acme/small")?.ref).toEqual(ref("acme", "small"));
});

it.each([
  ["openai/anthropic/small@work", "openai/gpt-4o-mini", "anthropic/small@work"],
  ["openai/gpt-4o-mini@work", "openrouter/openai/gpt-4o-mini", "openai/gpt-4o-mini"],
])("resolves profile-qualified primary %s in its own provider", (raw, target, alias) => {
  checkPrimary(config({ [target]: alias }, raw), raw, ref("openai", "gpt-4o-mini"));
});

it("resolves provider-qualified aliases without cross-provider collisions", () => {
  const resolve = resolver(config({ "local-a/small": "Local", "local-b/large": "Local" }));
  expect(resolve("local-a/Local")).toEqual({ ref: ref("local-a", "small"), alias: "Local" });
  expect(resolve("local-b/LOCAL")).toEqual({ ref: ref("local-b", "large"), alias: "Local" });
});

it.each([
  ["fixture/reasoner", "reasoner", "reasoner"],
  ["fixture/reasoner@work", "fixture/reasoner", "reasoner"],
  ["reasoner", "reasoner", "backup"],
  ["fixture/friendly", "friendly", "backup"],
])("keeps exact configured model identity for %s with alias %s", (raw, alias, expected) => {
  const cfg = config({ "fixture/backup": alias }, raw);
  cfg.models = {
    providers: {
      fixture: providerEntry("http://127.0.0.1:8080/v1", {
        api: "openai-completions",
        models: ["reasoner", "backup"].map((id) => modelDefinition(id)),
      }),
    },
  };
  checkPrimary(cfg, raw, ref("fixture", expected), true);
});
