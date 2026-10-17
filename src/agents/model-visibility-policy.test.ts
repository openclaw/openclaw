import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { getModelRefStatus } from "./model-selection-resolve.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

const sonnet = { provider: "anthropic", model: "claude-sonnet-4-6" };
const sol = { provider: "openai", model: "gpt-5.6-sol" };
const gpt = { provider: "openai", model: "gpt-5.5" };
const sensitive = { provider: "external", model: "sensitive" };
const haiku = { provider: "clawrouter", model: "anthropic/claude-haiku-4-5" };
const flash = { provider: "clawrouter", model: "google/gemini-3.5-flash" };
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
const defaultsConfig = (defaults: Defaults): OpenClawConfig => ({ agents: { defaults } });
const pickerPair = (primary: string, fallback: string) => ({
  primary: `demo/${primary}`,
  fallbacks: [`demo/${fallback}`],
});
function aliasPolicy(ref: string, alias = "sonnet") {
  return { models: { [ref]: { alias } }, modelPolicy: { allow: [alias] } };
}

function createPolicy(cfg: OpenClawConfig, agentId?: string) {
  return createModelVisibilityPolicy({
    cfg,
    catalog: [sonnet, haiku, flash, sensitive, gpt, sol].map(({ provider, model }) => ({
      provider,
      id: model,
      name: model,
    })),
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    agentId,
  });
}
const createDefaultPolicy = (defaults: Defaults) => createPolicy(defaultsConfig(defaults));

describe("explicit model visibility policy", () => {
  it("tracks every exact configured picker ref independently of the allow policy", () => {
    const cfg = {
      agents: {
        defaults: {
          model: pickerPair("default-primary", "default-fallback"),
          models: { "demo/default-alias": { alias: "default" } },
          utilityModel: "demo/default-utility",
          imageModel: pickerPair("image", "image-fallback"),
          pdfModel: pickerPair("pdf", "pdf-fallback"),
          modelPolicy: { allow: [] },
        },
        entries: {
          research: {
            model: pickerPair("primary", "fallback"),
            models: { "demo/agent-alias": { alias: "agent" } },
            utilityModel: "demo/agent-utility",
          },
        },
      },
    } as OpenClawConfig;
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: "openai",
      agentId: "research",
    });

    const configuredKeys = [
      "default-alias default-primary default-fallback agent-alias agent-utility",
      "image image-fallback pdf pdf-fallback primary fallback",
    ].flatMap((names) => names.split(" ").map((name) => JSON.stringify(["demo", name])));
    expect(configuredKeys.filter((key) => !policy.configuredKeys.has(key))).toEqual([]);
  });

  it("keeps overrides open when model entries only configure aliases or params", () => {
    const policy = createPolicy({
      meta: { migrations: { modelPolicyAllowlist: true } },
      ...defaultsConfig({ models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } } }),
    });
    expect(policy).toMatchObject({ allowAny: true });
    expect(policy.allows(sol)).toBe(true);
  });

  it("retains automatic defaults and fallbacks without permitting manual overrides", () => {
    const policy = createDefaultPolicy({
      model: { primary: "openai/gpt-5.5", fallbacks: ["external/sensitive"] },
      modelPolicy: { allow: ["openai/safe"] },
    });
    expect(policy.allows(gpt)).toBe(false);
    expect(policy.resolveSelection(gpt)).toEqual(gpt);
    expect(policy.allows({ provider: "openai", model: "safe" })).toBe(true);
    expect(policy.allows(sensitive)).toBe(false);
    expect(
      policy.allowedCatalog.some(
        (entry) => entry.provider === "external" && entry.id === "sensitive",
      ),
    ).toBe(false);
    expect(policy.retainedKeys).toEqual(
      new Set(['["openai","gpt-5.5"]', '["external","sensitive"]']),
    );
  });

  it("retains the selected default identity after manifest alias resolution", () => {
    const cfg = defaultsConfig({
      model: "custom/latest",
      modelPolicy: { allow: ["custom/other"] },
    });
    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
        },
      },
    ];
    const selected = resolveDefaultModelForAgent({
      cfg,
      manifestPlugins,
      allowPluginNormalization: false,
    });
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [],
      defaultProvider: selected.provider,
      defaultModel: selected,
      manifestPlugins,
      allowManifestNormalization: true,
    });
    expect(selected).toEqual({ provider: "custom", model: "middle" });
    expect(policy.retainedKeys).toEqual(new Set(['["custom","middle"]']));
    expect(policy.allows(selected)).toBe(false);
  });

  it("does not widen an unresolved legacy restriction while preserving its automatic default", () => {
    const policy = createModelVisibilityPolicy({
      cfg: { agents: { defaults: { models: { "/": {} }, model: "fixture/automatic" } } },
      catalog: [{ provider: "fixture", id: "other", name: "Other" }],
      defaultProvider: "fixture",
      defaultModel: "automatic",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    expect(policy).toMatchObject({ allowAny: false, allowedCatalog: [] });
    expect(policy.allows({ provider: "fixture", model: "other" })).toBe(false);
    expect(policy.allows({ provider: "fixture", model: "automatic" })).toBe(false);
    expect(policy.resolveSelection({ provider: "fixture", model: "automatic" })).toEqual({
      provider: "fixture",
      model: "automatic",
    });
  });

  it.each([
    ["custom/team", "Reader", "custom/*"],
    ["custom", "custom/team/Reader", "custom/team/*"],
  ])("keeps %s/%s outside the literal wildcard %s", (provider, model, allow) => {
    const cfg = defaultsConfig({ modelPolicy: { allow: [allow] } });
    const allowed = { provider: "custom", model: "team/Reader" };
    const candidate = { provider, model };
    const policy = createModelVisibilityPolicy({
      cfg,
      catalog: [
        { provider: allowed.provider, id: allowed.model, name: "Allowed model" },
        { provider, id: model, name: "Other literal default" },
      ],
      defaultProvider: provider,
      defaultModel: model,
    });

    expect(policy.allowAny).toBe(false);
    expect(policy.allows(allowed)).toBe(true);
    expect(policy.allowsByWildcard(allowed)).toBe(true);
    expect(policy.allows(candidate)).toBe(false);
    expect.soft(policy.allowsByWildcard(candidate)).toBe(false);
    expect.soft(policy.resolveSelection(candidate)).toEqual(allowed);
    const status = getModelRefStatus({
      cfg,
      catalog: policy.allowedCatalog,
      ref: candidate,
      defaultProvider: provider,
      defaultModel: model,
    });
    expect.soft(status.allowed).toBe(false);
  });

  it.each([
    ["clawrouter/anthropic/*", "openai/gpt-5.5"],
    [" clawrouter / anthropic / * ", " openai / gpt-5.5 "],
  ])("matches nested prefix wildcards on canonical boundaries: %s", (...allow) => {
    const policy = createDefaultPolicy({ modelPolicy: { allow } });

    const boundary = { provider: "clawrouter", model: "anthropicX/claude-haiku-4-5" };
    expect([haiku, boundary, flash, gpt, sol].map((ref) => policy.allows(ref))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(policy.allowsByWildcard(haiku)).toBe(true);
    expect(policy.allowsByWildcard(gpt)).toBe(false);
    expect(policy.allowedCatalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "clawrouter/anthropic/claude-haiku-4-5",
      "openai/gpt-5.5",
    ]);
  });

  it("resolves conflicting policy aliases in each agent's model map", () => {
    const entries = {
      research: aliasPolicy("anthropic/claude-sonnet-4-6"),
      writer: aliasPolicy("openai/gpt-5.6-sol"),
    };
    const cfg: OpenClawConfig = { agents: { entries } };
    const research = createPolicy(cfg, "research");
    expect(research.allows(sonnet)).toBe(true);
    expect(research.allows(sol)).toBe(false);

    const writer = createPolicy(cfg, "writer");
    expect(writer.allows(sol)).toBe(true);
    expect(writer.allows(sonnet)).toBe(false);
  });

  it.each([
    {
      name: "inherited default policy aliases",
      defaults: aliasPolicy("anthropic/claude-sonnet-4-6", "approved"),
      models: { "openai/gpt-5.6-sol": { alias: "approved" } },
      migrated: true,
      allowed: sonnet,
      denied: sol,
      paths: {},
    },
    {
      name: "explicit default policy despite unmarked agent metadata",
      defaults: { modelPolicy: { allow: ["openai/*"] } },
      models: { "external/sensitive": { alias: "sensitive" } },
      migrated: false,
      allowed: sol,
      denied: sensitive,
      paths: { allowAny: false, allowConfigPath: "agents.defaults.modelPolicy.allow" },
    },
    {
      name: "unmarked legacy default restrictions despite agent metadata",
      defaults: { models: { "openai/*": {} } },
      models: { "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
      migrated: false,
      allowed: sol,
      denied: sonnet,
      paths: {
        allowAny: false,
        allowConfigPath: "agents.defaults.models",
        allowRepairConfigPath: "agents.defaults.modelPolicy.allow",
      },
    },
  ])("resolves $name", ({ defaults, models, migrated, allowed, denied, paths }) => {
    const policy = createPolicy(
      {
        meta: migrated ? { migrations: { modelPolicyAllowlist: true } } : undefined,
        agents: { defaults, entries: { research: { models } } },
      },
      "research",
    );

    expect(policy).toMatchObject(paths);
    expect(policy.allows(allowed)).toBe(true);
    expect(policy.allows(denied)).toBe(false);
  });
});
