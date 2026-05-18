import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import gigachatPlugin from "./index.js";
import {
  applyGigachatConfig,
  applyGigachatProviderConfig,
  GIGACHAT_DEFAULT_MODEL_REF,
} from "./onboard.js";

function expectRecord<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (!value) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

describe("gigachat provider plugin", () => {
  it("registers GigaChat with Authorization-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(gigachatPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "gigachat-authorization-key",
    });

    expect(provider.id).toBe("gigachat");
    expect(provider.label).toBe("GigaChat");
    expect(provider.docsPath).toBe("/providers/gigachat");
    expect(provider.envVars).toEqual(["GIGACHAT_AUTHORIZATION_KEY"]);
    expect(provider.auth).toHaveLength(1);
    const resolvedChoice = expectRecord(resolved, "GigaChat provider choice");
    expect({
      providerId: resolvedChoice.provider.id,
      methodId: resolvedChoice.method.id,
    }).toEqual({
      providerId: "gigachat",
      methodId: "authorization-key",
    });
  });

  it("builds the static GigaChat model catalog", async () => {
    const provider = await registerSingleProviderPlugin(gigachatPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://gigachat.devices.sberbank.ru/api/v1");
    const models = expectRecord(catalogProvider.models, "GigaChat catalog models");
    expect(models.map((model) => model.id)).toEqual([
      "GigaChat-2",
      "GigaChat-2-Pro",
      "GigaChat-2-Max",
    ]);
    expect(models.every((model) => model.input.includes("text"))).toBe(true);
    expect(models.every((model) => model.compat?.supportsTools === true)).toBe(true);
  });

  it("uses the business endpoint when plugin config requests it", async () => {
    const provider = await registerSingleProviderPlugin(gigachatPlugin);
    const catalog = provider.catalog;
    if (!catalog) {
      throw new Error("catalog registration missing");
    }

    const result = await catalog.run({
      config: {
        plugins: {
          entries: {
            gigachat: {
              config: {
                endpoint: "business",
              },
            },
          },
        },
      },
      env: {
        GIGACHAT_AUTHORIZATION_KEY: "test-key",
      },
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    } as never);

    const providerConfig = expectRecord(
      result && "provider" in result ? result.provider : undefined,
      "GigaChat catalog result",
    );
    expect(providerConfig.baseUrl).toBe("https://api.giga.chat/v1");
    expect(providerConfig.apiKey).toBe("test-key");
  });

  it("adds GigaChat provider defaults without changing primary model in provider-only mode", () => {
    const cfg = applyGigachatProviderConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    });

    const modelsConfig = expectRecord(cfg.models, "models config");
    const providers = expectRecord(modelsConfig.providers, "model providers");
    const providerConfig = expectRecord(providers.gigachat, "GigaChat provider config");
    expect(providerConfig.api).toBe("openai-completions");
    expect(providerConfig.baseUrl).toBe("https://gigachat.devices.sberbank.ru/api/v1");
    const providerModels = expectRecord(providerConfig.models, "GigaChat provider models");
    expect(providerModels.map((model) => model.id)).toEqual([
      "GigaChat-2",
      "GigaChat-2-Pro",
      "GigaChat-2-Max",
    ]);
    const agentDefaults = expectRecord(cfg.agents?.defaults, "agent defaults");
    const agentModelAliases = expectRecord(agentDefaults.models, "agent model aliases");
    const gigachatAlias = expectRecord(
      agentModelAliases[GIGACHAT_DEFAULT_MODEL_REF],
      "GigaChat model alias",
    );
    expect(gigachatAlias.alias).toBe("GigaChat");
    expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe("anthropic/claude-opus-4-6");
  });

  it("sets GigaChat as the agent primary model in full onboarding mode", () => {
    const cfg = applyGigachatConfig({});

    const agentDefaults = expectRecord(cfg.agents?.defaults, "agent defaults");
    expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe(GIGACHAT_DEFAULT_MODEL_REF);
  });

  it("classifies GigaChat rate limit and context errors", async () => {
    const provider = await registerSingleProviderPlugin(gigachatPlugin);

    expect(
      provider.classifyFailoverReason?.({ errorMessage: "429 Too Many Requests" } as never),
    ).toBe("rate_limit");
    expect(provider.classifyFailoverReason?.({ errorMessage: "other" } as never)).toBeUndefined();
    expect(
      provider.matchesContextOverflowError?.({
        errorMessage: "GigaChat returned 422 Unprocessable Entity for context",
      } as never),
    ).toBe(true);
  });
});
