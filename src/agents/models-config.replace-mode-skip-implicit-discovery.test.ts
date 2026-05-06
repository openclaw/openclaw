import { describe, expect, it } from "vitest";
import {
  planOpenClawModelsJsonWithDeps,
  resolveProvidersForModelsJsonWithDeps,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

function createExplicitProvider(id: string): ProviderConfig {
  return {
    baseUrl: `https://${id}.example/v1`,
    api: "openai-completions",
    apiKey: `${id.toUpperCase()}_API_KEY`,
    models: [
      {
        id: `${id}-model`,
        name: `${id} model`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

describe("models-config replace mode skips implicit discovery", () => {
  it("does not call resolveImplicitProviders when mode is replace", async () => {
    let implicitProvidersCalled = false;

    const providers = await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              custom: createExplicitProvider("custom"),
            },
          },
        },
        agentDir: "/tmp/openclaw-replace-mode-test",
        env: {},
      },
      {
        resolveImplicitProviders: async () => {
          implicitProvidersCalled = true;
          return { implicit: createExplicitProvider("implicit") };
        },
      },
    );

    expect(implicitProvidersCalled).toBe(false);
    expect(providers["custom"]).toBeDefined();
    expect(providers["implicit"]).toBeUndefined();
  });

  it("returns only explicit providers when mode is replace", async () => {
    const providers = await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              "my-provider": createExplicitProvider("my-provider"),
            },
          },
        },
        agentDir: "/tmp/openclaw-replace-mode-test",
        env: {},
      },
      {
        resolveImplicitProviders: async () => {
          throw new Error("should not be called in replace mode");
        },
      },
    );

    expect(Object.keys(providers)).toEqual(["my-provider"]);
    expect(providers["my-provider"]?.baseUrl).toBe("https://my-provider.example/v1");
  });

  it("still calls resolveImplicitProviders when mode is merge", async () => {
    let implicitProvidersCalled = false;

    const providers = await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "merge",
            providers: {
              custom: createExplicitProvider("custom"),
            },
          },
        },
        agentDir: "/tmp/openclaw-replace-mode-test",
        env: {},
      },
      {
        resolveImplicitProviders: async () => {
          implicitProvidersCalled = true;
          return { implicit: createExplicitProvider("implicit") };
        },
      },
    );

    expect(implicitProvidersCalled).toBe(true);
    expect(providers["custom"]).toBeDefined();
    expect(providers["implicit"]).toBeDefined();
  });

  it("still calls resolveImplicitProviders when mode is unset (defaults to merge)", async () => {
    let implicitProvidersCalled = false;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: {
          models: {
            providers: {},
          },
        },
        agentDir: "/tmp/openclaw-replace-mode-test",
        env: {},
      },
      {
        resolveImplicitProviders: async () => {
          implicitProvidersCalled = true;
          return {};
        },
      },
    );

    expect(implicitProvidersCalled).toBe(true);
  });

  it("skips implicit discovery in planOpenClawModelsJsonWithDeps when mode is replace", async () => {
    let implicitProvidersCalled = false;

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            mode: "replace",
            providers: {
              custom: createExplicitProvider("custom"),
            },
          },
        },
        agentDir: "/tmp/openclaw-replace-mode-test",
        env: {},
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => {
          implicitProvidersCalled = true;
          return { implicit: createExplicitProvider("implicit") };
        },
      },
    );

    expect(implicitProvidersCalled).toBe(false);
    expect(plan.action).toBe("write");
    if (plan.action === "write") {
      const parsed = JSON.parse(plan.contents) as { providers: Record<string, unknown> };
      expect(parsed.providers["custom"]).toBeDefined();
      expect(parsed.providers["implicit"]).toBeUndefined();
    }
  });
});
