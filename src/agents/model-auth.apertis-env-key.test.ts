import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnvApiKey } from "./model-auth.js";

describe("resolveEnvApiKey for apertis", () => {
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

  it("resolves APERTIS_API_KEY for provider 'apertis'", () => {
    process.env.APERTIS_API_KEY = "sk-apertis-test-123";
    const result = resolveEnvApiKey("apertis");
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe("sk-apertis-test-123");
    expect(result!.source).toContain("APERTIS_API_KEY");
  });

  it("returns null when APERTIS_API_KEY is not set", () => {
    delete process.env.APERTIS_API_KEY;
    const result = resolveEnvApiKey("apertis");
    expect(result).toBeNull();
  });
});
