// Verifies configured model ref resolution and OpenRouter compatibility aliases.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { resolveAllowedModelRefCore } from "./model-selection-resolve.js";
import { resolveConfiguredModelRef } from "./model-selection-shared.js";

describe("model-selection-resolve OpenRouter compat aliases", () => {
  it("does not reinterpret a resolved string default as a configured alias", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "fixture-primary/primary" },
          models: { "fixture-alias/other": { alias: "primary" } },
          modelPolicy: { allow: ["fixture-primary/allowed"] },
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
    const result = withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      () => {
        const selected = resolveDefaultModelForAgent({ cfg });
        return resolveAllowedModelRefCore({
          cfg,
          catalog: [],
          raw: `${selected.provider}/${selected.model}`,
          defaultProvider: selected.provider,
          defaultModel: selected.model,
        });
      },
    );
    expect(result).toEqual({
      key: "fixture-primary/primary",
      ref: { provider: "fixture-primary", model: "primary" },
    });
  });

  it.each(["inherited", "explicit per-agent"])(
    "keeps %s policy aliases bound to their owner's metadata",
    (scope) => {
      const agentOwnsPolicy = scope === "explicit per-agent";
      const cfg: OpenClawConfig = {
        meta: { migrations: { modelPolicyAllowlist: true } },
        agents: {
          defaults: {
            models: { "fixture-default/raw": { alias: "approved" } },
            modelPolicy: { allow: ["approved"] },
          },
          list: [
            {
              id: "worker",
              models: { "fixture-agent/raw": { alias: "approved" } },
              ...(agentOwnsPolicy ? { modelPolicy: { allow: ["approved"] } } : {}),
            },
          ],
        },
      };
      const catalog = [
        { provider: "fixture-default", id: "default-model", name: "Default model" },
        { provider: "fixture-agent", id: "agent-model", name: "Agent model" },
      ];
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: catalog.map(({ provider }) => ({ id: provider, providers: [provider] })),
      });
      const pluginRegistry = createEmptyPluginRegistry();
      for (const { provider, id } of catalog) {
        pluginRegistry.providers.push({
          pluginId: provider,
          provider: {
            id: provider,
            label: provider,
            auth: [],
            normalizeModelId: ({ modelId }) => (modelId === "raw" ? id : modelId),
          },
          source: "test",
        });
      }
      const [alias, literal] = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry },
        () =>
          ["approved", "fixture-default/raw"].map((raw) =>
            resolveAllowedModelRefCore({
              cfg,
              catalog,
              raw,
              defaultProvider: "fixture-default",
              agentId: "worker",
              manifestPlugins: metadataSnapshot.plugins,
            }),
          ),
      );
      expect(alias).toEqual(
        agentOwnsPolicy
          ? {
              key: "fixture-agent/agent-model",
              ref: { provider: "fixture-agent", model: "agent-model" },
            }
          : { error: "model not allowed: fixture-agent/agent-model" },
      );
      expect(literal).toEqual(
        agentOwnsPolicy
          ? { error: "model not allowed: fixture-default/default-model" }
          : {
              key: "fixture-default/default-model",
              ref: { provider: "fixture-default", model: "default-model" },
            },
      );
    },
  );

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
        defaultModel: { provider: "ollama", model: "qwen35-27b-researcher" },
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
