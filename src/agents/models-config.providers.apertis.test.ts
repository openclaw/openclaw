import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Apertis provider", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.APERTIS_API_KEY;
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.APERTIS_API_KEY;
    } else {
      process.env.APERTIS_API_KEY = prev;
    }
  });

  it("should not include apertis when no API key is configured", async () => {
    delete process.env.APERTIS_API_KEY;
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });
    expect(providers?.apertis).toBeUndefined();
  });

  it("should include apertis when APERTIS_API_KEY is set", async () => {
    process.env.APERTIS_API_KEY = "sk-apertis-test";
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });
    expect(providers?.apertis).toBeDefined();
    expect(providers?.apertis?.apiKey).toBe("APERTIS_API_KEY");
    expect(providers?.apertis?.baseUrl).toBe("https://api.apertis.ai/v1");
    expect(providers?.apertis?.api).toBe("openai-completions");
  });
});
