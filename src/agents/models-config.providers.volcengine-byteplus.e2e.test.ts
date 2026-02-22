import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Volcengine and BytePlus providers", () => {
  it("includes volcengine and volcengine-plan when VOLCANO_ENGINE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY"]);
    process.env.VOLCANO_ENGINE_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.volcengine).toBeDefined();
      expect(providers?.["volcengine-plan"]).toBeDefined();
      expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("includes byteplus and byteplus-plan when BYTEPLUS_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["BYTEPLUS_API_KEY"]);
    process.env.BYTEPLUS_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.byteplus).toBeDefined();
      expect(providers?.["byteplus-plan"]).toBeDefined();
      expect(providers?.byteplus?.apiKey).toBe("BYTEPLUS_API_KEY");
      expect(providers?.["byteplus-plan"]?.apiKey).toBe("BYTEPLUS_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });
});
