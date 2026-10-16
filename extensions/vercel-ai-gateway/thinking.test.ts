import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("vercel ai gateway thinking profile", () => {
  async function resolveThinkingProfile(modelId: string) {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "vercel-ai-gateway",
      name: "Vercel AI Gateway Provider",
    });
    return requireRegisteredProvider(providers, "vercel-ai-gateway").resolveThinkingProfile?.({
      provider: "vercel-ai-gateway",
      modelId,
    });
  }

  it("exposes Codex xhigh through the OpenAI upstream prefix", async () => {
    expect(await resolveThinkingProfile("openai/gpt-5.3-codex-spark")).toStrictEqual({
      levels: ["off", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
    });
  });

  it("reuses Claude thinking defaults for trusted Anthropic upstream refs", async () => {
    expect(await resolveThinkingProfile("anthropic/claude-opus-4.6")).toStrictEqual({
      levels: ["off", "minimal", "low", "medium", "high", "adaptive"].map((id) => ({ id })),
      defaultLevel: "adaptive",
    });
  });

  it("falls through for unsupported OpenAI or untrusted namespaced refs", async () => {
    expect(await resolveThinkingProfile("openai/gpt-4.1")).toBeUndefined();
    expect(await resolveThinkingProfile("acme/gpt-5.4")).toBeUndefined();
  });
});
