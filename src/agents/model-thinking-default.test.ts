import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveDirectBundledProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

describe("resolveThinkingDefault", () => {
  it.each([
    { thinking: false, agentDefault: undefined, expected: "off" },
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

  it.each([{ provider: "anthropic", model: "claude-opus-5", reasoning: true, expected: "high" }])(
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

  it.each([
    { model: "Kimi-K3", thinking: undefined, agentDefault: undefined, expected: "off" },
    { model: "Kimi-K3", thinking: "max", agentDefault: undefined, expected: "max" },
    { model: "Kimi-K3", thinking: "low", agentDefault: "medium", expected: "medium" },
    { model: "k3", thinking: undefined, agentDefault: undefined, expected: "high" },
    { model: "k3-256k", thinking: undefined, agentDefault: undefined, expected: "high" },
  ] as const)(
    "preserves fresh and serialized Kimi defaults (model=$model, thinking=$thinking, agent=$agentDefault)",
    ({ model, thinking, agentDefault, expected }) => {
      const resolveThinkingProfile =
        resolveDirectBundledProviderPolicySurface("kimi-coding")?.resolveThinkingProfile;
      if (!resolveThinkingProfile) {
        throw new Error("Missing thinking policy for kimi");
      }
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `kimi/${model}` },
            models: { [`kimi/${model}`]: { params: { thinking } } },
          },
          entries: { alpha: { thinkingDefault: agentDefault } },
        },
      };
      for (const [state, cfg] of [
        ["fresh", config],
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Persisted JSON omits undefined preferences.
        ["serialized existing", JSON.parse(JSON.stringify(config))],
      ] as const) {
        expect(
          resolveThinkingDefault({
            cfg,
            agentId: "alpha",
            provider: "kimi",
            model,
            catalog: [{ provider: "kimi", id: model, name: model, reasoning: true }],
            providerPolicySource: {
              providers: [{ provider: { id: "kimi", resolveThinkingProfile } }],
            },
          }),
          state,
        ).toBe(expected);
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
