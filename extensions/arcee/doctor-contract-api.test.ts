// Arcee tests cover upgrade repair for the shipped OpenRouter onboarding shape.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type ModelDefinition = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string]["models"][number];

function modelDefinition(id: string, name: string): ModelDefinition {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

const legacyCatalog = [
  modelDefinition("arcee-ai/trinity-large-preview", "Trinity Large Preview"),
  modelDefinition("arcee-ai/trinity-large-thinking", "Trinity Large Thinking"),
];

function shippedOpenRouterConfig(): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "openrouter:default": { provider: "openrouter", mode: "api_key" },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "arcee/trinity-large-thinking",
          fallbacks: ["arcee/trinity-large-preview", "openai/gpt-5.5"],
        },
        models: {
          "arcee/trinity-large-thinking": { alias: "Arcee AI (OpenRouter)" },
          "openai/gpt-5.5": { alias: "Primary fallback" },
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        arcee: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          models: legacyCatalog,
        },
      },
    },
  } as OpenClawConfig;
}

describe("Arcee doctor contract", () => {
  it("detects only OpenRouter-backed Arcee provider catalogs", () => {
    const rule = legacyConfigRules[0];
    expect(rule?.match?.({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(rule?.match?.({ baseUrl: "https://api.arcee.ai/api/v1" })).toBe(false);
    expect(rule?.message).toContain("openclaw doctor --fix");
  });

  it("migrates the shipped catalog, default, fallbacks, and alias to OpenRouter ownership", () => {
    const config = shippedOpenRouterConfig();
    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Moved the OpenRouter-backed Arcee catalog from models.providers.arcee to models.providers.openrouter and repaired its model references.",
    ]);
    expect(result.config.models?.providers?.arcee).toBeUndefined();
    expect(result.config.models?.providers?.openrouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      models: legacyCatalog,
    });
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "openrouter/arcee-ai/trinity-large-thinking",
      fallbacks: ["openrouter/arcee-ai/trinity-large-preview", "openai/gpt-5.5"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "openrouter/arcee-ai/trinity-large-thinking": { alias: "Arcee AI (OpenRouter)" },
      "openai/gpt-5.5": { alias: "Primary fallback" },
    });
    expect(result.config.auth).toEqual(config.auth);
    expect(config.models?.providers?.arcee).toBeDefined();
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("merges catalog rows into an existing OpenRouter provider without overwriting it", () => {
    const config = shippedOpenRouterConfig();
    if (!config.models?.providers) {
      throw new Error("expected provider config");
    }
    config.models.providers.openrouter = {
      baseUrl: "https://openrouter-proxy.example.test/v1",
      api: "openai-responses",
      models: [
        modelDefinition("arcee-ai/trinity-large-thinking", "Operator override"),
        modelDefinition("other/model", "Other model"),
      ],
    };

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.config.models?.providers?.openrouter).toMatchObject({
      baseUrl: "https://openrouter-proxy.example.test/v1",
      api: "openai-responses",
      models: [
        { id: "arcee-ai/trinity-large-thinking", name: "Operator override" },
        { id: "other/model", name: "Other model" },
        { id: "arcee-ai/trinity-large-preview", name: "Trinity Large Preview" },
      ],
    });
  });

  it.each(["defaults", "entries", "list"] as const)(
    "repairs every supported model selection in agents.%s before removing the legacy provider",
    (scope) => {
      const legacy = "arcee/trinity-large-thinking";
      const canonical = "openrouter/arcee-ai/trinity-large-thinking";
      const selection = {
        primary: legacy,
        fallbacks: ["arcee/trinity-large-preview", "other/model"],
      };
      const repaired = {
        primary: canonical,
        fallbacks: ["openrouter/arcee-ai/trinity-large-preview", "other/model"],
      };
      const agent = {
        id: "worker",
        name: legacy, // Only model fields migrate, never arbitrary strings.
        model: selection,
        imageModel: legacy,
        voiceModel: selection,
        pdfModel: selection,
        utilityModel: legacy,
        modelPolicy: { allow: [legacy, "other/model"] },
        mediaModels: { image: selection, video: legacy, music: selection },
        heartbeat: { model: legacy, every: "30m" },
        subagents: { model: selection, allowAgents: ["worker"] },
        compaction: { model: legacy, memoryFlush: { model: legacy, prompt: legacy } },
        models: {
          [legacy]: { alias: "Legacy alias", params: { temperature: 0.4 } },
          [canonical]: { alias: "Operator alias" },
          "other/model": { alias: "Unrelated" },
        },
      };
      const expectedAgent = {
        ...agent,
        model: repaired,
        imageModel: canonical,
        voiceModel: repaired,
        pdfModel: repaired,
        utilityModel: canonical,
        modelPolicy: { allow: [canonical, "other/model"] },
        mediaModels: { image: repaired, video: canonical, music: repaired },
        heartbeat: { ...agent.heartbeat, model: canonical },
        subagents: { ...agent.subagents, model: repaired },
        compaction: {
          model: canonical,
          memoryFlush: { model: canonical, prompt: legacy },
        },
        models: {
          [canonical]: { alias: "Operator alias", params: { temperature: 0.4 } },
          "other/model": { alias: "Unrelated" },
        },
      };
      const wrapScope = (value: typeof agent) =>
        scope === "defaults"
          ? { defaults: value }
          : scope === "entries"
            ? { entries: { worker: value, unchanged: { name: "Untouched" } } }
            : { list: [value, { id: "unchanged", name: "Untouched" }] };
      // Doctor accepts the shipped list shape before core upgrades it to entries.
      const config = { ...shippedOpenRouterConfig(), agents: wrapScope(agent) } as OpenClawConfig;
      const before = structuredClone(config);
      const result = normalizeCompatibilityConfig({ cfg: config });

      expect(result.config.agents).toEqual(wrapScope(expectedAgent));
      expect(result.config.models?.providers?.arcee).toBeUndefined();
      expect(config).toEqual(before);
      expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
        config: result.config,
        changes: [],
      });
    },
  );

  it("preserves canonical model-map precedence regardless of insertion order", () => {
    const config = shippedOpenRouterConfig();
    const defaults = config.agents?.defaults;
    if (!defaults) {
      throw new Error("expected agent defaults");
    }
    defaults.models = {
      "openrouter/arcee-ai/trinity-large-thinking": { alias: "Operator alias" },
      "arcee/trinity-large-thinking": { alias: "Legacy alias", params: { temperature: 0.4 } },
    };
    expect(normalizeCompatibilityConfig({ cfg: config }).config.agents?.defaults?.models).toEqual({
      "openrouter/arcee-ai/trinity-large-thinking": {
        alias: "Operator alias",
        params: { temperature: 0.4 },
      },
    });
  });

  it("leaves direct Arcee configuration unchanged", () => {
    const config = {
      agents: {
        defaults: {
          model: "arcee/trinity-large-thinking",
          subagents: { model: "arcee/trinity-large-preview" },
        },
        entries: { worker: { model: "arcee/trinity-large-thinking" } },
      },
      models: {
        providers: {
          arcee: {
            baseUrl: "https://api.arcee.ai/api/v1",
            api: "openai-completions",
            models: [modelDefinition("trinity-large-thinking", "Trinity Large Thinking")],
          },
        },
      },
    } as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });
});
