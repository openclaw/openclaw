import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AISA_BASE_URL,
  AISA_DEFAULT_MODEL_ID,
  buildAisaProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

describe("buildAisaProvider", () => {
  it("returns provider with correct base URL and API type", () => {
    const provider = buildAisaProvider();
    expect(provider.baseUrl).toBe("https://api.aisa.one/v1");
    expect(provider.api).toBe("openai-completions");
  });

  it("includes three default models", () => {
    const provider = buildAisaProvider();
    expect(provider.models).toHaveLength(3);
    const ids = provider.models.map((m) => m.id);
    expect(ids).toContain("qwen3-max");
    expect(ids).toContain("deepseek-v3.1");
    expect(ids).toContain("kimi-k2.5");
  });

  it("marks qwen3-max as vision-capable", () => {
    const provider = buildAisaProvider();
    const qwen = provider.models.find((m) => m.id === "qwen3-max");
    expect(qwen?.input).toContain("image");
  });

  it("marks all models as reasoning", () => {
    const provider = buildAisaProvider();
    for (const model of provider.models) {
      expect(model.reasoning).toBe(true);
    }
  });

  it("sets supportsDeveloperRole to false on all models", () => {
    const provider = buildAisaProvider();
    for (const model of provider.models) {
      expect(model.compat?.supportsDeveloperRole).toBe(false);
    }
  });
});

describe("AIsa provider constants", () => {
  it("exports correct base URL", () => {
    expect(AISA_BASE_URL).toBe("https://api.aisa.one/v1");
  });

  it("exports correct default model ID", () => {
    expect(AISA_DEFAULT_MODEL_ID).toBe("qwen3-max");
  });
});

describe("AIsa implicit provider", () => {
  it("should include aisa when AISA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.AISA_API_KEY;
    process.env.AISA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.aisa).toBeDefined();
      expect(providers?.aisa?.apiKey).toBe("AISA_API_KEY");
      expect(providers?.aisa?.baseUrl).toBe("https://api.aisa.one/v1");
      expect(providers?.aisa?.api).toBe("openai-completions");
    } finally {
      if (previous === undefined) {
        delete process.env.AISA_API_KEY;
      } else {
        process.env.AISA_API_KEY = previous;
      }
    }
  });

  it("should not include aisa when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.AISA_API_KEY;
    delete process.env.AISA_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.aisa).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env.AISA_API_KEY = previous;
      }
    }
  });
});
