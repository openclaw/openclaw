import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildStaticInworldProvider } from "./provider-catalog.js";

const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage): ModelRegistry;
};

const registerInworldPlugin = () =>
  registerProviderPlugin({ plugin, id: "inworld", name: "Inworld" });

describe("inworld provider hooks", () => {
  it("registers the inworld LLM provider alongside the existing speech provider", async () => {
    const { providers, speechProviders } = await registerInworldPlugin();
    expect(providers.map((p) => p.id)).toEqual(["inworld"]);
    expect(speechProviders.map((p) => p.id)).toEqual(["inworld"]);
  });

  it("exposes the auto model in the static fallback catalog", () => {
    const ids = buildStaticInworldProvider().models?.map((m) => m.id) ?? [];
    expect(ids).toContain("auto");
  });

  it("resolves the default auto model id to an openai-completions descriptor", async () => {
    const { providers } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(providers, "inworld");

    const resolved = provider.resolveDynamicModel?.({
      provider: "inworld",
      modelId: "auto",
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error("inworld provider did not resolve auto");
    }

    expect(resolved.provider).toBe("inworld");
    expect(resolved.id).toBe("auto");
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.baseUrl).toBe("https://api.inworld.ai/v1");
    expect(resolved.compat?.supportsTools).toBe(true);
  });

  it("falls back to conservative defaults for unknown model ids", async () => {
    const { providers } = await registerInworldPlugin();
    const provider = requireRegisteredProvider(providers, "inworld");

    const resolved = provider.resolveDynamicModel?.({
      provider: "inworld",
      modelId: "unknown/no-such-model",
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error("inworld provider did not resolve unknown model");
    }

    expect(resolved.id).toBe("unknown/no-such-model");
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.reasoning).toBe(false);
    expect(resolved.input).toEqual(["text"]);
  });
});
