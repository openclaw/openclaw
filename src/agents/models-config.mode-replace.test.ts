import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveProvidersForModelsJsonWithDeps } from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

function bailianProvider(): ProviderConfig {
  return {
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    apiKey: "DASHSCOPE_API_KEY",
    models: [
      {
        id: "qwen3-coder-plus",
        name: "Qwen3 Coder Plus",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

function codexImplicitProvider(): ProviderConfig {
  return {
    baseUrl: "https://chatgpt.com/backend-api/v1",
    api: "openai-codex-responses",
    apiKey: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-5.4-codex",
        name: "GPT-5.4 Codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

describe("resolveProvidersForModelsJsonWithDeps — models.mode", () => {
  it("includes implicit providers when mode is undefined (default)", async () => {
    const cfg: OpenClawConfig = {
      models: { providers: { bailian: bailianProvider() } },
    };
    const resolveImplicit = vi.fn().mockResolvedValue({ codex: codexImplicitProvider() });

    const providers = await resolveProvidersForModelsJsonWithDeps(
      { cfg, agentDir: "/tmp/test-agent", env: {} },
      { resolveImplicitProviders: resolveImplicit },
    );

    expect(resolveImplicit).toHaveBeenCalledTimes(1);
    expect(Object.keys(providers).toSorted()).toEqual(["bailian", "codex"]);
  });

  it("includes implicit providers when mode is 'merge'", async () => {
    const cfg: OpenClawConfig = {
      models: { mode: "merge", providers: { bailian: bailianProvider() } },
    };
    const resolveImplicit = vi.fn().mockResolvedValue({ codex: codexImplicitProvider() });

    const providers = await resolveProvidersForModelsJsonWithDeps(
      { cfg, agentDir: "/tmp/test-agent", env: {} },
      { resolveImplicitProviders: resolveImplicit },
    );

    expect(resolveImplicit).toHaveBeenCalledTimes(1);
    expect(Object.keys(providers).toSorted()).toEqual(["bailian", "codex"]);
  });

  it("excludes implicit providers when mode is 'replace' — #68965", async () => {
    const cfg: OpenClawConfig = {
      models: { mode: "replace", providers: { bailian: bailianProvider() } },
    };
    const resolveImplicit = vi.fn().mockResolvedValue({ codex: codexImplicitProvider() });

    const providers = await resolveProvidersForModelsJsonWithDeps(
      { cfg, agentDir: "/tmp/test-agent", env: {} },
      { resolveImplicitProviders: resolveImplicit },
    );

    // The fix: implicit fetch is skipped entirely, and the result contains
    // ONLY the explicit providers from config.
    expect(resolveImplicit).not.toHaveBeenCalled();
    expect(Object.keys(providers)).toEqual(["bailian"]);
    expect(providers.codex).toBeUndefined();
  });
});
