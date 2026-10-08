import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import * as providers from "./models-config.providers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

afterEach(() => vi.restoreAllMocks());

function createExplicitProvider(): ProviderConfig {
  return {
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "EXPLICIT_API_KEY",
    models: [
      {
        id: "test/explicit-model",
        name: "Explicit Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

describe("models-config plan: replace mode skips implicit discovery", () => {
  it("publishes only chat endpoints when decision providers share the config map", async () => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: {
        mode: "replace",
        providers: {
          explicit: explicitProvider,
          judge: {
            ...explicitProvider,
            api: undefined,
            type: "decision",
            decisionProvider: "typesafe",
          },
        },
      },
    };
    const plan = await planModelsJsonForTest({
      cfg,
      agentDir: "/tmp/openclaw-models-config-decision-test",
      env: {},
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`Expected write plan, got ${plan.action}`);
    }
    expect(JSON.parse(plan.contents).providers).toEqual({ explicit: explicitProvider });
    expect(plan.contents).not.toContain("judge");
  });

  it("skips implicit discovery in replace mode", async () => {
    const explicitProvider = createExplicitProvider();
    const cfg: OpenClawConfig = {
      models: { mode: "replace", providers: { explicit: explicitProvider } },
    };
    const resolveImplicitSpy = vi
      .spyOn(providers, "resolveImplicitProviders")
      .mockResolvedValue({ unwanted: explicitProvider });
    const plan = await planModelsJsonForTest({
      cfg,
      agentDir: "/tmp/openclaw-models-config-replace-test",
      env: {},
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    expect(resolveImplicitSpy).not.toHaveBeenCalled();
    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`Expected write plan, got ${plan.action}`);
    }
    expect(JSON.parse(plan.contents).providers).toEqual({ explicit: explicitProvider });
  });
});
