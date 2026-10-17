// Verifies simple-completion model selection preserves provider, model, and profile refs.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import {
  acquireSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent as resolveSimpleCompletionSelectionForAgentBase,
} from "./simple-completion-runtime.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

function resolveSimpleCompletionSelectionForAgent(
  cfg: OpenClawConfig,
  params: Omit<Parameters<typeof resolveSimpleCompletionSelectionForAgentBase>[0], "cfg"> = {
    agentId: "main",
  },
) {
  const selection = resolveSimpleCompletionSelectionForAgentBase({
    ...params,
    cfg: createCanonicalAgentConfigFixture(cfg).config,
  });
  if (!selection) {
    throw new Error("expected simple completion selection");
  }
  return selection;
}
const utilityDefaults = {
  model: "anthropic/claude-opus-4-6",
  utilityModel: "openai/gpt-5.4-mini",
};

describe("resolveSimpleCompletionSelectionForAgent", () => {
  it("resolves explicit aliases in the selected agent scope", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/global-model",
          models: {
            "openai/global-model": { alias: "fast" },
          },
        },
        entries: {
          worker: {
            models: {
              "anthropic/worker-model": { alias: "fast" },
            },
          },
        },
      },
    };

    expect(
      resolveSimpleCompletionSelectionForAgentBase({
        cfg,
        agentId: "worker",
        modelRef: "fast",
      }),
    ).toMatchObject({ provider: "anthropic", modelId: "worker-model" });
    expect(
      resolveSimpleCompletionSelectionForAgentBase({
        cfg,
        agentId: "main",
        modelRef: "fast",
      }),
    ).toMatchObject({ provider: "openai", modelId: "global-model" });
  });

  it.each([
    {
      model: "openrouter/aurora-alpha",
      acp: false,
      expected: { provider: "openrouter", modelId: "openrouter/aurora-alpha" },
    },
    {
      model: "openrouter/aurora-alpha@harness-profile",
      acp: true,
      expected: { provider: "anthropic", modelId: "claude-opus-4-6", profileId: "native-profile" },
    },
    {
      model: "harness-only[context=272k]@harness-profile",
      acp: true,
      expected: { provider: "anthropic", modelId: "claude-opus-4-6", profileId: "native-profile" },
    },
  ])(
    "selects the native completion route for model=$model ACP=$acp",
    ({ model, acp, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "anthropic/claude-opus-4-6@native-profile" },
          entries: { ops: { model, ...(acp ? { runtime: { type: "acp" } } : {}) } },
        },
      };

      const selection = resolveSimpleCompletionSelectionForAgent(cfg, { agentId: "ops" });
      expect(selection).toMatchObject(expected);
    },
  );

  it.each([true, "required"] as const)(
    "uses the default utility model for utility mode %s",
    (useUtilityModel) => {
      const cfg: OpenClawConfig = { agents: { defaults: utilityDefaults } };
      const utilitySelection = resolveSimpleCompletionSelectionForAgent(cfg, {
        agentId: "main",
        useUtilityModel,
      });
      const normalSelection = resolveSimpleCompletionSelectionForAgent(cfg);

      expect(utilitySelection).toMatchObject({ provider: "openai", modelId: "gpt-5.4-mini" });
      expect(normalSelection).toMatchObject({ provider: "anthropic", modelId: "claude-opus-4-6" });
    },
  );

  it("prefers the per-agent utility model and keeps explicit operation overrides highest", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: utilityDefaults,
        entries: { ops: { utilityModel: "google/gemini-3.1-flash-lite-preview" } },
      },
    };

    const agentSelection = resolveSimpleCompletionSelectionForAgent(cfg, {
      agentId: "ops",
      useUtilityModel: true,
    });
    const explicitSelection = resolveSimpleCompletionSelectionForAgent(cfg, {
      agentId: "ops",
      modelRef: "openrouter/mistralai/mistral-small",
      useUtilityModel: true,
    });

    expect(agentSelection).toMatchObject({
      provider: "google",
      modelId: "gemini-3.1-flash-lite",
    });
    expect(explicitSelection).toMatchObject({
      provider: "openrouter",
      modelId: "mistralai/mistral-small",
    });
  });

  it("treats an empty utility model as disabled and uses the primary", () => {
    const cfg: OpenClawConfig = { agents: { defaults: { ...utilityDefaults, utilityModel: "" } } };
    const selection = resolveSimpleCompletionSelectionForAgent(cfg, {
      agentId: "main",
      useUtilityModel: true,
    });
    expect(selection).toMatchObject({ provider: "anthropic", modelId: "claude-opus-4-6" });
  });

  it.each([
    { label: "disabled", utilityModel: "" },
    { label: "unavailable", utilityModel: undefined },
    { label: "invalid", utilityModel: "/" },
    { label: "invalid override", utilityModel: "fixture/utility", modelRef: "/" },
  ])(
    "does not prepare the primary when required utility routing is $label",
    async ({ utilityModel, modelRef }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "fixture/primary", utilityModel },
        },
      };
      expect(
        resolveSimpleCompletionSelectionForAgentBase({
          cfg,
          agentId: "main",
          modelRef,
          useUtilityModel: "required",
          manifestPlugins: [],
        }),
      ).toBeNull();

      const modelResolver = vi.fn<SimpleCompletionModelResolver>();
      await expect(
        acquireSimpleCompletionModelForAgent({
          cfg,
          agentId: "main",
          modelRef,
          useUtilityModel: "required",
          modelResolver,
        }),
      ).resolves.toEqual({ error: "No model configured for agent main." });
      expect(modelResolver).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit utility operation model when required utility routing is disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: "fixture/primary", utilityModel: "" },
      },
    };
    expect(
      resolveSimpleCompletionSelectionForAgentBase({
        cfg,
        agentId: "main",
        modelRef: "fixture/operation",
        useUtilityModel: "required",
      }),
    ).toMatchObject({ provider: "fixture", modelId: "operation" });
  });

  it("resolves alias refs before parsing provider/model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "fast@work",
          models: {
            "openrouter/anthropic/claude-sonnet-4-6": { alias: "fast" },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSimpleCompletionSelectionForAgent(cfg)).toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4-6",
      profileId: "work",
    });
  });

  it("falls back to runtime default model when no explicit model is configured", () => {
    const selection = resolveSimpleCompletionSelectionForAgent({});
    expect(selection).toMatchObject({ provider: "openai", modelId: "gpt-6-astra" });
  });

  it("uses the configured provider model when the runtime default is unavailable", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 200_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSimpleCompletionSelectionForAgent(cfg)).toMatchObject({
      provider: "openai",
      modelId: "gpt-5",
    });
  });
});
