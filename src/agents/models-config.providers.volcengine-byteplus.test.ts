import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { upsertAuthProfile } from "./auth-profiles.js";
import { BYTEPLUS_DEFAULT_COST } from "./byteplus-models.js";
import { DOUBAO_DEFAULT_COST } from "./doubao-models.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("Volcengine and BytePlus providers", () => {
  it("includes volcengine and volcengine-plan when VOLCANO_ENGINE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY"]);
    process.env.VOLCANO_ENGINE_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
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
    process.env.BYTEPLUS_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.byteplus).toBeDefined();
      expect(providers?.["byteplus-plan"]).toBeDefined();
      expect(providers?.byteplus?.apiKey).toBe("BYTEPLUS_API_KEY");
      expect(providers?.["byteplus-plan"]?.apiKey).toBe("BYTEPLUS_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("doubao default cost has non-zero context caching prices", () => {
    expect(DOUBAO_DEFAULT_COST.cacheRead).toBeGreaterThan(0);
    expect(DOUBAO_DEFAULT_COST.cacheWrite).toBeGreaterThan(0);
    // cacheRead should be cheaper than input (discount for cached tokens)
    expect(DOUBAO_DEFAULT_COST.cacheRead).toBeLessThan(DOUBAO_DEFAULT_COST.input);
    // cacheWrite should be at least as expensive as input
    expect(DOUBAO_DEFAULT_COST.cacheWrite).toBeGreaterThanOrEqual(DOUBAO_DEFAULT_COST.input);
  });

  it("byteplus default cost has non-zero context caching prices", () => {
    expect(BYTEPLUS_DEFAULT_COST.cacheRead).toBeGreaterThan(0);
    expect(BYTEPLUS_DEFAULT_COST.cacheWrite).toBeGreaterThan(0);
    // cacheRead should be cheaper than input (discount for cached tokens)
    expect(BYTEPLUS_DEFAULT_COST.cacheRead).toBeLessThan(BYTEPLUS_DEFAULT_COST.input);
    // cacheWrite should be at least as expensive as input
    expect(BYTEPLUS_DEFAULT_COST.cacheWrite).toBeGreaterThanOrEqual(BYTEPLUS_DEFAULT_COST.input);
  });

  it("includes providers when auth profiles are env keyRef-only", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "BYTEPLUS_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.BYTEPLUS_API_KEY;

    upsertAuthProfile({
      profileId: "volcengine:default",
      credential: {
        type: "api_key",
        provider: "volcengine",
        keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      },
      agentDir,
    });
    upsertAuthProfile({
      profileId: "byteplus:default",
      credential: {
        type: "api_key",
        provider: "byteplus",
        keyRef: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
      },
      agentDir,
    });

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.volcengine?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.["volcengine-plan"]?.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(providers?.byteplus?.apiKey).toBe("BYTEPLUS_API_KEY");
      expect(providers?.["byteplus-plan"]?.apiKey).toBe("BYTEPLUS_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });
});
