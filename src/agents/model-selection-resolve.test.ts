// Verifies configured model ref resolution and OpenRouter compatibility aliases.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveAllowedModelRefCore,
  resolveConfiguredModelRef,
} from "./model-selection-resolve.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("implicit primary selection with an explicit utility model", () => {
  const provider = "local-utility";
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
            baseUrl: "http://127.0.0.1:9/v1",
            models: [
              makeProviderModelFixture({
                id: "small",
                provider,
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:9/v1",
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

  it.each(["local-utility/small", " Local-Utility/small@utility:setup ", "helper@utility:setup"])(
    "separates migrated utility ref %s while preserving the legacy implicit primary",
    (utilityModel) => {
      const cfg = config();
      expectDefined(cfg.agents?.defaults, "default agent config").utilityModel = utilityModel;
      cfg.meta = undefined;
      expect(resolve(cfg)).toEqual({ provider, model: "small" });
      expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });

      cfg.meta = { migrations: { utilityModelSeparation: true } };
      expect(resolve(cfg)).toEqual({ provider: "ordinary", model: "primary" });
      expect(resolve(cfg, "worker")).toEqual({ provider: "ordinary", model: "primary" });
    },
  );

  it.each([
    { utilityModel: "helper@agent", expectedProvider: "ordinary", expectedModel: "primary" },
    { utilityModel: "other/small", expectedProvider: provider, expectedModel: "small" },
    { utilityModel: "", expectedProvider: provider, expectedModel: "small" },
  ])("honors the agent utility override $utilityModel", (scenario) => {
    const cfg = config();
    expectDefined(cfg.agents?.entries?.worker, "worker config").utilityModel =
      scenario.utilityModel;
    cfg.meta = undefined;
    expect(resolve(cfg, "worker")).toEqual({ provider, model: "small" });
    expect(resolve(cfg)).toEqual({ provider, model: "small" });

    cfg.meta = { migrations: { utilityModelSeparation: true } };
    expect(resolve(cfg, "worker")).toEqual({
      provider: scenario.expectedProvider,
      model: scenario.expectedModel,
    });
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
  it("keeps inherited policy aliases bound to default metadata for per-agent selection", () => {
    const cfg = {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "approved" },
          },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          {
            id: "worker",
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "approved" },
            },
          },
        ],
      },
    } as OpenClawConfig;
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "approved",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({ error: "model not allowed: anthropic/claude-sonnet-4-6" });
    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openai/gpt-5.5",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({
      key: "openai/gpt-5.5",
      ref: { provider: "openai", model: "gpt-5.5" },
    });
  });

  it("binds explicit per-agent policy aliases to per-agent metadata", () => {
    const cfg = {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { alias: "approved" } },
          modelPolicy: { allow: ["approved"] },
        },
        list: [
          {
            id: "worker",
            models: { "anthropic/claude-sonnet-4-6": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
        ],
      },
    } as OpenClawConfig;
    const catalog = [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "approved",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({
      key: "anthropic/claude-sonnet-4-6",
      ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openai/gpt-5.5",
        defaultProvider: "openai",
        agentId: "worker",
      }),
    ).toEqual({ error: "model not allowed: openai/gpt-5.5" });
  });

  it("preserves exact configured proxy provider ids for cron-style aliases", () => {
    // Proxy providers can intentionally own short ids like "cron"; keep the
    // configured provider scope instead of treating the id as a global alias.
    const cfg = {
      agents: {
        defaults: {
          models: {
            "litellm/cron": {},
          },
        },
      },
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
    ).toEqual({
      key: "litellm/cron",
      ref: { provider: "litellm", model: "cron" },
    });
  });

  it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
    // Colon syntax is a legacy operator shortcut for OpenRouter's auto route.
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openrouter:auto" },
        },
      },
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
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
          },
        },
      },
    } as OpenClawConfig;

    const catalog = [
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b-instruct:free",
        name: "Llama 3.3 70B Free",
      },
    ];

    expect(
      resolveAllowedModelRefCore({
        cfg,
        catalog,
        raw: "openrouter:free",
        defaultProvider: "anthropic",
      }),
    ).toEqual({
      ref: {
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct:free",
      },
      key: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    });
  });
});
