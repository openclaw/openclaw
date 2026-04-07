import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveImplicitProvidersForTest } from "../../src/agents/models-config.e2e-harness.js";

describe("Kilo Gateway implicit provider", () => {
  it("should include kilocode when KILOCODE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    process.env.KILOCODE_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kilocode).toBeDefined();
      expect(providers?.kilocode?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include kilocode when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    delete process.env.KILOCODE_API_KEY;

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kilocode).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should preserve an explicit kilocode provider override", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    process.env.KILOCODE_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProvidersForTest({
        agentDir,
        explicitProviders: {
          kilocode: {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });
      expect(providers?.kilocode?.baseUrl).toBe("https://proxy.example.com/v1");
    } finally {
      envSnapshot.restore();
    }
  });
});
