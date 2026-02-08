import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CambAiConfigSchema,
  resolveCambAiConfig,
  validateCambAiConfig,
  type CambAiConfig,
} from "./config.js";

function createBaseConfig(overrides: Partial<CambAiConfig> = {}): CambAiConfig {
  return {
    enabled: true,
    apiKey: "test-api-key",
    tts: {
      model: "mars-flash",
      defaultLanguage: "en-us",
      defaultVoiceId: 123,
      outputFormat: "mp3",
    },
    voiceCloning: { enabled: false },
    soundGeneration: { enabled: false },
    pollingIntervalMs: 2000,
    pollingTimeoutMs: 120000,
    ...overrides,
  };
}

describe("CambAiConfigSchema", () => {
  it("parses valid config with all fields", () => {
    const input = {
      enabled: true,
      apiKey: "my-key",
      tts: {
        model: "mars-pro",
        defaultLanguage: "es-es",
        defaultVoiceId: 456,
        outputFormat: "wav",
      },
      voiceCloning: { enabled: true },
      soundGeneration: { enabled: true },
      pollingIntervalMs: 3000,
      pollingTimeoutMs: 60000,
    };

    const result = CambAiConfigSchema.parse(input);

    expect(result.enabled).toBe(true);
    expect(result.apiKey).toBe("my-key");
    expect(result.tts.model).toBe("mars-pro");
    expect(result.tts.defaultLanguage).toBe("es-es");
    expect(result.tts.defaultVoiceId).toBe(456);
    expect(result.tts.outputFormat).toBe("wav");
    expect(result.voiceCloning.enabled).toBe(true);
    expect(result.soundGeneration.enabled).toBe(true);
  });

  it("applies default values for missing optional fields", () => {
    const input = {};

    const result = CambAiConfigSchema.parse(input);

    expect(result.enabled).toBe(true);
    expect(result.apiKey).toBeUndefined();
    expect(result.tts.model).toBe("mars-flash");
    expect(result.tts.defaultLanguage).toBe("en-us");
    expect(result.tts.defaultVoiceId).toBeUndefined();
    expect(result.tts.outputFormat).toBe("mp3");
    expect(result.voiceCloning.enabled).toBe(false);
    expect(result.soundGeneration.enabled).toBe(true); // Defaults to true
    expect(result.pollingIntervalMs).toBe(2000);
    expect(result.pollingTimeoutMs).toBe(120000);
  });

  it("accepts all valid TTS model values", () => {
    const models = ["mars-flash", "mars-pro", "mars-instruct", "auto"];

    for (const model of models) {
      const result = CambAiConfigSchema.parse({ tts: { model } });
      expect(result.tts.model).toBe(model);
    }
  });

  it("accepts all valid output format values", () => {
    const formats = ["mp3", "wav"];

    for (const outputFormat of formats) {
      const result = CambAiConfigSchema.parse({ tts: { outputFormat } });
      expect(result.tts.outputFormat).toBe(outputFormat);
    }
  });
});

describe("resolveCambAiConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CAMB_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses apiKey from config when provided", () => {
    const config = createBaseConfig({ apiKey: "config-key" });

    const result = resolveCambAiConfig(config);

    expect(result.apiKey).toBe("config-key");
  });

  it("falls back to CAMB_API_KEY env var when config apiKey is missing", () => {
    process.env.CAMB_API_KEY = "env-key";
    const config = createBaseConfig({ apiKey: undefined });

    const result = resolveCambAiConfig(config);

    expect(result.apiKey).toBe("env-key");
  });

  it("prefers config apiKey over env var", () => {
    process.env.CAMB_API_KEY = "env-key";
    const config = createBaseConfig({ apiKey: "config-key" });

    const result = resolveCambAiConfig(config);

    expect(result.apiKey).toBe("config-key");
  });

  it("returns undefined apiKey when neither config nor env var is set", () => {
    const config = createBaseConfig({ apiKey: undefined });

    const result = resolveCambAiConfig(config);

    expect(result.apiKey).toBeUndefined();
  });
});

describe("validateCambAiConfig", () => {
  it("passes validation when enabled and apiKey is present", () => {
    const config = createBaseConfig({ enabled: true, apiKey: "my-key" });

    const result = validateCambAiConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("skips validation when enabled is false", () => {
    const config = createBaseConfig({ enabled: false, apiKey: undefined });

    const result = validateCambAiConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails validation when enabled but apiKey is missing", () => {
    const config = createBaseConfig({ enabled: true, apiKey: undefined });

    const result = validateCambAiConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "plugins.entries.camb-ai.config.apiKey is required (or set CAMB_API_KEY env var)",
    );
  });

  it("fails validation when enabled but apiKey is empty string", () => {
    const config = createBaseConfig({ enabled: true, apiKey: "" });

    const result = validateCambAiConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
