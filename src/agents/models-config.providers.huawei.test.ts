import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Huawei MAAS provider", () => {
  it("should include huawei-maas with default models when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previousHuaweiMaas = process.env.HUAWEI_MAAS_API_KEY;

    try {
      delete process.env.HUAWEI_MAAS_API_KEY;

      const providers = await resolveImplicitProviders({ agentDir });

      // Huawei MAAS should always be included, even without API key (using default models)
      expect(providers?.["huawei-maas"]).toBeDefined();
      expect(providers?.["huawei-maas"]?.models).toBeDefined();
      expect(providers?.["huawei-maas"]?.models?.length).toBeGreaterThan(0);
      expect(providers?.["huawei-maas"]?.apiKey).toBeUndefined();
    } finally {
      if (previousHuaweiMaas === undefined) {
        delete process.env.HUAWEI_MAAS_API_KEY;
      } else {
        process.env.HUAWEI_MAAS_API_KEY = previousHuaweiMaas;
      }
    }
  });

  it("should include huawei-maas with API key when configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previousHuaweiMaas = process.env.HUAWEI_MAAS_API_KEY;

    try {
      process.env.HUAWEI_MAAS_API_KEY = "test-api-key";

      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.["huawei-maas"]).toBeDefined();
      expect(providers?.["huawei-maas"]?.apiKey).toBe("test-api-key");
      expect(providers?.["huawei-maas"]?.models).toBeDefined();
      expect(providers?.["huawei-maas"]?.models?.length).toBeGreaterThan(0);
    } finally {
      if (previousHuaweiMaas === undefined) {
        delete process.env.HUAWEI_MAAS_API_KEY;
      } else {
        process.env.HUAWEI_MAAS_API_KEY = previousHuaweiMaas;
      }
    }
  });
});
