import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveAllowedModelRefCore,
  resolveConfiguredModelRef,
} from "./model-selection-resolve.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const openai = { provider: "openai", model: "gpt-5.5" };
const anthropic = { provider: "anthropic", model: "claude-sonnet-4-6" };
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
function modelConfig(models: Defaults["models"]): OpenClawConfig {
  return { agents: { defaults: { models } } };
}
function policyOwner(ref: { provider: string; model: string }) {
  return { models: { [`${ref.provider}/${ref.model}`]: { alias: "approved" } } };
}
function allowed(ref: { provider: string; model: string }) {
  return { key: `${ref.provider}/${ref.model}`, ref };
}
function providerConfig(provider: string, id: string, baseUrl: string): OpenClawConfig["models"] {
  const api = "openai-completions";
  const model = makeProviderModelFixture<"openai-completions">({ id, provider, api, baseUrl });
  return { providers: { [provider]: { baseUrl, api, models: [model] } } };
}
function resolveAllowed(
  cfg: OpenClawConfig,
  raw: string,
  options: Partial<Parameters<typeof resolveAllowedModelRefCore>[0]> = {},
) {
  const { catalog = [], defaultProvider = "anthropic", ...rest } = options;
  return resolveAllowedModelRefCore({ ...rest, cfg, raw, catalog, defaultProvider });
}

describe("implicit primary selection with an explicit utility model", () => {
  const provider = "local-utility";
  const baseUrl = "http://127.0.0.1:9/v1";
  function config(): OpenClawConfig {
    return {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: {
          utilityModel: `${provider}/small`,
          models: { [`${provider}/small`]: { alias: "helper" } },
        },
        entries: { worker: {} },
      },
      models: providerConfig(provider, "small", baseUrl),
    };
  }
  function resolve(cfg: OpenClawConfig, agentId?: string) {
    return resolveConfiguredModelRef({
      cfg,
      agentId,
      defaultProvider: "ordinary",
      defaultModel: "primary",
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
  }
  function owner(cfg: OpenClawConfig, scope: string) {
    return expectDefined(
      scope === "defaults" ? cfg.agents?.defaults : cfg.agents?.entries?.worker,
      "model config owner",
    );
  }

  it.each([
    { scope: "defaults", utilityModel: " Local-Utility/small@utility:setup ", excluded: true },
    { scope: "defaults", utilityModel: "helper@utility:setup", excluded: true },
    { scope: "agent", utilityModel: "helper@agent", excluded: true },
    { scope: "agent", utilityModel: "other/small", excluded: false },
    { scope: "agent", utilityModel: "", excluded: false },
  ])("separates migrated $scope utility $utilityModel from the legacy primary", (scenario) => {
    const cfg = config();
    owner(cfg, scenario.scope).utilityModel = scenario.utilityModel;
    cfg.meta = undefined;
    expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });
    expect(resolve(cfg)).toEqual({ provider, model: "small" });

    cfg.meta = { migrations: { utilityModelSeparation: true } };
    expect(resolve(cfg, "worker")).toEqual(
      scenario.excluded ? { provider: "ordinary", model: "primary" } : { provider, model: "small" },
    );
    expect(resolve(cfg)).toEqual({ provider: "ordinary", model: "primary" });
  });

  it.each(["defaults", "agent"])("preserves explicit utility model as %s primary", (scope) => {
    const cfg = config();
    owner(cfg, scope).model = {
      primary: `${provider}/small@primary:chosen`,
      fallbacks: ["ordinary/backup"],
    };
    expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });
  });
});

describe("model-selection-resolve OpenRouter compat aliases", () => {
  it.each([false, true])("binds aliases to policy owner (agent policy: %s)", (agentPolicy) => {
    const cfg: OpenClawConfig = {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: { ...policyOwner(openai), modelPolicy: { allow: ["approved"] } },
        entries: {
          worker: {
            ...policyOwner(anthropic),
            ...(agentPolicy ? { modelPolicy: { allow: ["approved"] } } : {}),
          },
        },
      },
    };
    const catalog = [openai, anthropic].map(({ provider, model }) => ({
      provider,
      id: model,
      name: model,
    }));
    const resolve = (raw: string) =>
      resolveAllowed(cfg, raw, { catalog, defaultProvider: "openai", agentId: "worker" });

    expect(resolve("approved")).toEqual(
      agentPolicy
        ? allowed(anthropic)
        : { error: "model not allowed: anthropic/claude-sonnet-4-6" },
    );
    expect(resolve("openai/gpt-5.5")).toEqual(
      agentPolicy ? { error: "model not allowed: openai/gpt-5.5" } : allowed(openai),
    );
  });

  it("preserves exact configured proxy provider ids for cron-style aliases", () => {
    const cfg: OpenClawConfig = {
      ...modelConfig({ "litellm/cron": {} }),
      models: providerConfig("litellm", "cron", "http://127.0.0.1:4000/v1"),
    };

    expect(
      resolveAllowed(cfg, "litellm/cron", {
        defaultProvider: "ollama",
        defaultModel: "qwen35-27b-researcher",
      }),
    ).toEqual(allowed({ provider: "litellm", model: "cron" }));
  });

  it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openrouter:auto" } } },
    };

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
  });

  it("resolves openrouter:free through the runtime allowlist path", () => {
    const ref = { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" };
    const cfg = modelConfig({ [`${ref.provider}/${ref.model}`]: {} });
    const catalog = [{ provider: ref.provider, id: ref.model, name: "Llama 3.3 70B Free" }];

    expect(resolveAllowed(cfg, "openrouter:free", { catalog })).toEqual(allowed(ref));
  });
});
