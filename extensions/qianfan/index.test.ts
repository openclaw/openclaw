import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import qianfanPlugin from "./index.js";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function expectRecord<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (!value) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

describe("qianfan provider plugin", () => {
  it("registers Qianfan with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "qianfan-api-key",
    });

    expect(provider.id).toBe("qianfan");
    expect(provider.label).toBe("Qianfan");
    expect(provider.docsPath).toBe("/providers/qianfan");
    expect(provider.envVars).toEqual(["QIANFAN_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    const resolvedChoice = expectRecord(resolved, "Qianfan provider choice");
    expect({
      providerId: resolvedChoice.provider.id,
      methodId: resolvedChoice.method.id,
    }).toEqual({
      providerId: "qianfan",
      methodId: "api-key",
    });
  });

  it("declares OpenAI-compatible streaming usage support in the manifest", () => {
    expect(manifest.providerRequest.providers).toMatchObject({
      qianfan: {
        openAICompletions: { supportsStreamingUsage: true },
      },
    });
  });

  it.each([
    { mode: undefined, modelIds: [] },
    {
      mode: "replace" as const,
      modelIds: [
        "deepseek-v4-pro",
        "ernie-5.1",
        "ernie-5.0",
        "deepseek-v3.2",
        "ernie-5.0-thinking-preview",
      ],
    },
  ])(
    "sets Qianfan's default without persisting ordinary $mode catalog rows",
    ({ mode, modelIds }) => {
      const cfg = applyQianfanConfig({ models: { mode } });

      const agentsConfig = expectRecord(cfg.agents, "agents config");
      const agentDefaults = expectRecord(agentsConfig.defaults, "agent defaults");
      expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe(QIANFAN_DEFAULT_MODEL_REF);
      expect(cfg.models?.providers?.qianfan?.models.map((model) => model.id)).toEqual(modelIds);
    },
  );
});
