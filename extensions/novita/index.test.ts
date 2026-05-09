import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import novitaPlugin from "./index.js";
import { NOVITA_DEFAULT_MODEL_REF, applyNovitaConfig } from "./onboard.js";
import { buildStaticNovitaProvider } from "./provider-catalog.js";

function expectRecord<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (!value) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

describe("novita provider plugin", () => {
  it("registers Novita AI with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(novitaPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "novita-api-key",
    });

    expect(provider.id).toBe("novita");
    expect(provider.label).toBe("Novita AI");
    expect(provider.docsPath).toBe("/providers/novita");
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    const resolvedChoice = expectRecord(resolved, "Novita provider choice");
    expect({
      providerId: resolvedChoice.provider.id,
      methodId: resolvedChoice.method.id,
    }).toEqual({
      providerId: "novita",
      methodId: "api-key",
    });
  });

  it("builds the curated Novita AI static catalog", async () => {
    const catalogProvider = buildStaticNovitaProvider();

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.novita.ai/openai/v1");
    const models = expectRecord(catalogProvider.models, "Novita catalog models");
    expect(models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "moonshotai/kimi-k2.6",
      "zai-org/glm-5.1",
      "xiaomimimo/mimo-v2.5-pro",
      "minimax/minimax-m2.7",
    ]);
    expect(
      expectRecord(
        models.find((model) => model.id === "deepseek/deepseek-v4-pro"),
        "DeepSeek V4 Pro model",
      ),
    ).toMatchObject({
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
      contextWindow: 1_048_576,
      maxTokens: 384_000,
    });
  });

  it("does not run live Novita AI catalog without auth", async () => {
    const provider = await registerSingleProviderPlugin(novitaPlugin);

    const catalog = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "" }),
      resolveProviderAuth: () => ({ apiKey: "", mode: "missing", source: "missing" }),
    } as never);

    expect(catalog).toBeNull();
  });

  it("sets Novita AI as the agent primary model in onboarding mode", () => {
    const cfg = applyNovitaConfig({});

    const agentsConfig = expectRecord(cfg.agents, "agents config");
    const agentDefaults = expectRecord(agentsConfig.defaults, "agent defaults");
    expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe(NOVITA_DEFAULT_MODEL_REF);
    const providerConfig = expectRecord(cfg.models?.providers?.novita, "Novita provider config");
    expect(providerConfig.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(providerConfig.api).toBe("openai-completions");
  });
});
