import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveDirectBundledProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import { configForProviders, modelDefinition } from "./model-auth.fixtures.test-support.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
type Agents = NonNullable<OpenClawConfig["agents"]>;
const config = (
  defaults: Agents["defaults"],
  alpha?: NonNullable<Agents["entries"]>[string],
): OpenClawConfig => ({ agents: { defaults, ...(alpha ? { entries: { alpha } } : {}) } });

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

function expectThinking(
  params: Parameters<typeof resolveThinkingDefault>[0],
  expected: ReturnType<typeof resolveThinkingDefault>,
  state?: string,
) {
  expect(resolveThinkingDefault(params), state).toBe(expected);
}

function thinkingPolicy(provider: string, policyProvider = provider) {
  const resolveThinkingProfile =
    resolveDirectBundledProviderPolicySurface(policyProvider)?.resolveThinkingProfile;
  if (!resolveThinkingProfile) {
    throw new Error(`Missing thinking policy for ${provider}`);
  }
  return { providers: [{ provider: { id: provider, resolveThinkingProfile } }] };
}

describe("resolveThinkingDefault", () => {
  it.each([
    { thinking: false, agentDefault: undefined, expected: "off" },
    { thinking: "high", agentDefault: "minimal", expected: "minimal" },
  ] as const)(
    "resolves agent thinking defaults (model=$thinking, agent=$agentDefault)",
    ({ thinking, agentDefault, expected }) => {
      const cfg = config(
        {
          thinkingDefault: "low",
          models: { "fixture/reasoning-model": { params: { thinking: "high" } } },
        },
        {
          thinkingDefault: agentDefault,
          models: { "fixture/reasoning-model": { params: { thinking } } },
        },
      );
      expectThinking(
        { cfg, agentId: "alpha", provider: "fixture", model: "reasoning-model" },
        expected,
      );
    },
  );

  it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
    expectThinking(
      {
        cfg: config({
          models: { "openrouter/openrouter/hunter-alpha": { params: { thinking: "high" } } },
        }),
        provider: "openrouter",
        model: "openrouter/hunter-alpha",
      },
      "high",
    );
  });

  it("honors configured anthropic/claude-opus-5 policy with reasoning=true", () => {
    const provider = "anthropic",
      model = "claude-opus-5";
    expectThinking(
      {
        cfg: config({ model: { primary: `${provider}/${model}` } }),
        provider,
        model,
        agentRuntime: "openclaw",
        catalog: [{ provider, id: model, name: model, reasoning: true }],
        providerPolicySource: thinkingPolicy(provider),
      },
      "high",
    );
  });

  it.each([
    { model: "Kimi-K3", thinking: undefined, agentDefault: undefined, expected: "off" },
    { model: "Kimi-K3", thinking: "max", agentDefault: undefined, expected: "max" },
    { model: "Kimi-K3", thinking: "low", agentDefault: "medium", expected: "medium" },
    { model: "k3", thinking: undefined, agentDefault: undefined, expected: "high" },
    { model: "k3-256k", thinking: undefined, agentDefault: undefined, expected: "high" },
  ] as const)(
    "preserves fresh and serialized Kimi defaults (model=$model, thinking=$thinking, agent=$agentDefault)",
    ({ model, thinking, agentDefault, expected }) => {
      const providerPolicySource = thinkingPolicy("kimi", "kimi-coding");
      const fresh = config(
        {
          model: { primary: `kimi/${model}` },
          models: { [`kimi/${model}`]: { params: { thinking } } },
        },
        { thinkingDefault: agentDefault },
      );
      for (const [state, cfg] of [
        ["fresh", fresh],
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Persisted JSON omits undefined preferences.
        ["serialized existing", JSON.parse(JSON.stringify(fresh))],
      ] as const) {
        expectThinking(
          {
            cfg,
            agentId: "alpha",
            provider: "kimi",
            model,
            catalog: [{ provider: "kimi", id: model, name: model, reasoning: true }],
            providerPolicySource,
          },
          expected,
          state,
        );
      }
    },
  );

  it("honors configured provider models that disable reasoning", () => {
    const cfg = configForProviders({
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          modelDefinition("gemma-4-26b-a4b-it", {
            name: "Gemma 4 26B",
            reasoning: false,
            contextWindow: 32_000,
            maxTokens: 8_192,
          }),
        ],
      },
    });
    expectThinking({ cfg, provider: "google", model: "gemma-4-26b-a4b-it" }, "off");
  });
});
