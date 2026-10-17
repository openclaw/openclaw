// Verifies configured model ref resolution and OpenRouter compatibility aliases.
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
function allowed(ref: { provider: string; model: string }) {
  return { key: `${ref.provider}/${ref.model}`, ref };
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
      models: {
        providers: {
          [provider]: {
            baseUrl,
            models: [
              makeProviderModelFixture({
                id: "small",
                provider,
                api: "openai-completions",
                baseUrl,
              }),
            ],
          },
        },
      },
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

  it.each([
    { scope: "defaults", utilityModel: " Local-Utility/small@utility:setup ", excluded: true },
    { scope: "defaults", utilityModel: "helper@utility:setup", excluded: true },
    { scope: "agent", utilityModel: "helper@agent", excluded: true },
    { scope: "agent", utilityModel: "other/small", excluded: false },
    { scope: "agent", utilityModel: "", excluded: false },
  ])("separates migrated $scope utility $utilityModel from the legacy primary", (scenario) => {
    const cfg = config();
    const owner = expectDefined(
      scenario.scope === "defaults" ? cfg.agents?.defaults : cfg.agents?.entries?.worker,
      "utility model config owner",
    );
    owner.utilityModel = scenario.utilityModel;
    cfg.meta = undefined;
    expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });
    expect(resolve(cfg)).toEqual({ provider, model: "small" });

    cfg.meta = { migrations: { utilityModelSeparation: true } };
    expect(resolve(cfg, "worker")).toEqual(
      scenario.excluded ? { provider: "ordinary", model: "primary" } : { provider, model: "small" },
    );
    expect(resolve(cfg)).toEqual({ provider: "ordinary", model: "primary" });
  });

  it.each(["defaults", "agent"])(
    "preserves an explicit utility model chosen as %s primary",
    (scope) => {
      const cfg = config();
      const owner = expectDefined(
        scope === "defaults" ? cfg.agents?.defaults : cfg.agents?.entries?.worker,
        "model config owner",
      );
      owner.model = { primary: `${provider}/small@primary:chosen`, fallbacks: ["ordinary/backup"] };
      expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });
    },
  );
});

describe("model-selection-resolve OpenRouter compat aliases", () => {
  it.each([false, true])(
    "binds policy aliases to their owner (agent policy: %s)",
    (agentPolicy) => {
      const cfg = {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
          entries: {
            worker: {
              models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
              ...(agentPolicy ? { modelPolicy: { allow: ["approved"] } } : {}),
            },
          },
        },
      } as OpenClawConfig;
      const catalog = [
        { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ];
      const resolve = (raw: string) =>
        resolveAllowedModelRefCore({
          cfg,
          catalog,
          raw,
          defaultProvider: "openai",
          agentId: "worker",
        });

      expect(resolve("approved")).toEqual(
        agentPolicy
          ? allowed(anthropic)
          : { error: "model not allowed: anthropic/claude-sonnet-4-6" },
      );
      expect(resolve("openai/gpt-5.5")).toEqual(
        agentPolicy ? { error: "model not allowed: openai/gpt-5.5" } : allowed(openai),
      );
    },
  );

  it("preserves exact configured proxy provider ids for cron-style aliases", () => {
    const cfg = {
      agents: { defaults: { models: { "litellm/cron": {} } } },
      models: {
        providers: {
          litellm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4000/v1",
            models: [{ id: "cron", name: "Cron route" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog: [],
        raw: "litellm/cron",
        defaultProvider: "ollama",
        defaultModel: "qwen35-27b-researcher",
      }),
    ).toEqual(allowed({ provider: "litellm", model: "cron" }));
  });

  it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
    const cfg = {
      agents: { defaults: { model: { primary: "openrouter:auto" } } },
    } as OpenClawConfig;

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
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { [`${ref.provider}/${ref.model}`]: {} } } },
    };
    const catalog = [{ provider: ref.provider, id: ref.model, name: "Llama 3.3 70B Free" }];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openrouter:free",
        defaultProvider: "anthropic",
      }),
    ).toEqual(allowed(ref));
  });
});
