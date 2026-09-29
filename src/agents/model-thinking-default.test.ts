import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveDirectBundledProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import { PREPARED_THINKING_POLICY } from "../plugins/provider-thinking-catalog.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

describe("resolveThinkingDefault", () => {
  it.each([
    { thinking: "extra-high", expected: "xhigh" },
    { thinking: false, expected: "off" },
    { thinking: "disabled", expected: "off" },
  ])(
    "prefers and normalizes per-model thinking=$thinking over global defaults",
    ({ thinking, expected }) => {
      expect(
        resolveThinkingDefault({
          cfg: {
            agents: {
              defaults: {
                thinkingDefault: "low",
                models: { "fixture/reasoning-model": { params: { thinking } } },
              },
            },
          },
          provider: "fixture",
          model: "reasoning-model",
        }),
      ).toBe(expected);
    },
  );

  it.each([
    { thinking: false, agentDefault: undefined, expected: "off" },
    { thinking: "extra-high", agentDefault: undefined, expected: "xhigh" },
    { thinking: "high", agentDefault: "minimal", expected: "minimal" },
  ] as const)(
    "resolves agent thinking defaults (model=$thinking, agent=$agentDefault)",
    ({ thinking, agentDefault, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: { "fixture/reasoning-model": { params: { thinking: "high" } } },
          },
          entries: {
            alpha: {
              thinkingDefault: agentDefault,
              models: { "fixture/reasoning-model": { params: { thinking } } },
            },
          },
        },
      };
      expect(
        resolveThinkingDefault({
          cfg,
          agentId: "alpha",
          provider: "fixture",
          model: "reasoning-model",
        }),
      ).toBe(expected);
    },
  );

  it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
    expect(
      resolveThinkingDefault({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openrouter/openrouter/hunter-alpha": { params: { thinking: "high" } },
              },
            },
          },
        },
        provider: "openrouter",
        model: "openrouter/hunter-alpha",
      }),
    ).toBe("high");
  });

  it.each([
    { provider: "anthropic", model: "claude-opus-5", reasoning: true, expected: "high" },
    { provider: "anthropic", model: "claude-opus-4-7", reasoning: true, expected: "off" },
    { provider: "anthropic", model: "claude-opus-4-8", reasoning: true, expected: "off" },
    { provider: "anthropic", model: "claude-sonnet-4-6", reasoning: true, expected: "adaptive" },
    { provider: "anthropic", model: "claude-opus-4-80", reasoning: true, expected: "medium" },
    { provider: "anthropic-vertex", model: "claude-opus-4-8", reasoning: true, expected: "off" },
    { provider: "claude-cli", model: "claude-opus-4-8", reasoning: true, expected: "off" },
    { provider: "anthropic", model: "claude-opus-5", reasoning: false, expected: "off" },
    { provider: "anthropic", model: "claude-fable-5", reasoning: false, expected: "medium" },
  ])(
    "honors configured $provider/$model policy with reasoning=$reasoning",
    ({ provider, model, reasoning, expected }) => {
      const resolveThinkingProfile = resolveDirectBundledProviderPolicySurface(
        provider === "anthropic-vertex" ? provider : "anthropic",
      )?.resolveThinkingProfile;
      if (!resolveThinkingProfile) {
        throw new Error(`Missing thinking policy for ${provider}`);
      }
      expect(
        resolveThinkingDefault({
          cfg: { agents: { defaults: { model: { primary: `${provider}/${model}` } } } },
          provider,
          model,
          agentRuntime: provider === "claude-cli" ? "claude-cli" : "openclaw",
          catalog: [{ provider, id: model, name: model, reasoning }],
          providerPolicySource: {
            providers: [{ provider: { id: provider, resolveThinkingProfile } }],
          },
        }),
      ).toBe(expected);
    },
  );

  it.each(["registry", "prepared", "prepared-null"])(
    "uses the %s policy owner for configured defaults",
    (source) => {
      const resolveThinkingProfile = vi.fn(() => ({
        levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }] as const,
        defaultLevel: "low" as const,
      }));
      const registryPolicy =
        source === "registry"
          ? resolveThinkingProfile
          : vi.fn(() => ({ levels: [{ id: "high" }] as const, defaultLevel: "high" as const }));
      const model = "claude-opus-5";
      const catalog = [
        {
          provider: "anthropic",
          id: model,
          name: model,
          reasoning: true,
          ...(source === "registry"
            ? {}
            : {
                [PREPARED_THINKING_POLICY]:
                  source === "prepared-null" ? null : resolveThinkingProfile,
              }),
        },
      ];
      expect(
        resolveThinkingDefault({
          cfg: { agents: { defaults: { model: { primary: `anthropic/${model}` } } } },
          provider: "anthropic",
          model,
          catalog,
          agentRuntime: "claude-cli",
          providerPolicySource: {
            providers: [{ provider: { id: "anthropic", resolveThinkingProfile: registryPolicy } }],
          },
        }),
      ).toBe(source === "prepared-null" ? "medium" : "low");
      expect(resolveThinkingProfile).toHaveBeenCalledTimes(source === "prepared-null" ? 0 : 1);
      if (source !== "registry") {
        expect(registryPolicy).not.toHaveBeenCalled();
      }
    },
  );

  it("honors configured provider models that disable reasoning", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemma-4-26b-a4b-it",
                name: "Gemma 4 26B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };
    expect(resolveThinkingDefault({ cfg, provider: "google", model: "gemma-4-26b-a4b-it" })).toBe(
      "off",
    );
  });
});
