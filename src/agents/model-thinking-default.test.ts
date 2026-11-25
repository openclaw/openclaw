import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveDirectBundledProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import { configFor, modelDefinition } from "./model-auth.fixtures.test-support.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] });
type Agents = NonNullable<OpenClawConfig["agents"]>;
const config = (
  defaults: Agents["defaults"],
  alpha?: NonNullable<Agents["entries"]>[string],
): OpenClawConfig => ({ agents: { defaults, ...(alpha ? { entries: { alpha } } : {}) } });
const modelThinking = (key: string, thinking?: string | boolean) => ({
  [key]: { params: { thinking } },
});
const resolveFor =
  (
    provider: string,
    model: string,
    options: Partial<Parameters<typeof resolveThinkingDefault>[0]> = {},
  ) =>
  (cfg: OpenClawConfig) =>
    resolveThinkingDefault({ ...options, cfg, provider, model });

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => metadataSnapshot,
}));

function policyResolver(provider: string, model: string, agentId?: string, agentRuntime?: string) {
  const resolveThinkingProfile = resolveDirectBundledProviderPolicySurface(
    provider === "kimi" ? "kimi-coding" : provider,
  )?.resolveThinkingProfile;
  if (!resolveThinkingProfile) {
    throw new Error(`Missing thinking policy for ${provider}`);
  }
  return resolveFor(provider, model, {
    agentId,
    agentRuntime,
    catalog: [{ provider, id: model, name: model, reasoning: true }],
    providerPolicySource: { providers: [{ provider: { id: provider, resolveThinkingProfile } }] },
  });
}

describe("resolveThinkingDefault", () => {
  it.each([
    [false, undefined, "off"],
    ["high", "minimal", "minimal"],
  ] as const)("agent precedence (%s, %s)", (thinking, agentDefault, expected) => {
    const key = "fixture/reasoning-model";
    const cfg = config(
      { thinkingDefault: "low", models: modelThinking(key, "high") },
      { thinkingDefault: agentDefault, models: modelThinking(key, thinking) },
    );
    expect(resolveFor("fixture", "reasoning-model", { agentId: "alpha" })(cfg)).toBe(expected);
  });

  it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
    const model = "openrouter/hunter-alpha";
    const cfg = config({ models: modelThinking(`openrouter/${model}`, "high") });
    expect(resolveFor("openrouter", model)(cfg)).toBe("high");
  });

  it("honors configured anthropic/claude-opus-5 policy with reasoning=true", () => {
    const provider = "anthropic",
      model = "claude-opus-5";
    const resolve = policyResolver(provider, model, undefined, "openclaw");
    expect(resolve(config({ model: { primary: `${provider}/${model}` } }))).toBe("high");
  });

  it.each([
    ["Kimi-K3", undefined, undefined, "off"],
    ["Kimi-K3", "max", undefined, "max"],
    ["Kimi-K3", "low", "medium", "medium"],
    ["k3", undefined, undefined, "high"],
    ["k3-256k", undefined, undefined, "high"],
  ] as const)(
    "preserves fresh and serialized Kimi defaults (%s, thinking=%s, agent=%s)",
    (model, thinking, agentDefault, expected) => {
      const resolve = policyResolver("kimi", model, "alpha");
      const fresh = config(
        {
          model: { primary: `kimi/${model}` },
          models: modelThinking(`kimi/${model}`, thinking),
        },
        { thinkingDefault: agentDefault },
      );
      expect(resolve(fresh), "fresh").toBe(expected);
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Persisted JSON omits undefined preferences.
      expect(resolve(JSON.parse(JSON.stringify(fresh))), "serialized existing").toBe(expected);
    },
  );

  it("honors configured provider models that disable reasoning", () => {
    const cfg = configFor("google", "https://generativelanguage.googleapis.com/v1beta", {
      api: "google-generative-ai",
      models: [modelDefinition("gemma-4-26b-a4b-it", { reasoning: false })],
    });
    expect(resolveFor("google", "gemma-4-26b-a4b-it")(cfg)).toBe("off");
  });
});
