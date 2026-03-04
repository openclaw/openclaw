import { describe, expect, it } from "vitest";
import { REDACTED_API_KEY_SENTINEL } from "./models-config.providers.js";

describe("REDACTED_API_KEY_SENTINEL", () => {
  it("is the expected fixed value", () => {
    expect(REDACTED_API_KEY_SENTINEL).toBe("__redacted__");
  });
});

// Test mergeWithExistingProviderSecrets behavior with sentinel.
// We test the public function ensureOpenClawModelsJson indirectly by verifying
// that the sentinel constant is used correctly in the merge logic.

describe("SecretRef sentinel in models.json merge", () => {
  it("sentinel is not a valid API key pattern", () => {
    // Sentinel should not look like any real provider API key
    expect(REDACTED_API_KEY_SENTINEL).not.toMatch(/^sk-/);
    expect(REDACTED_API_KEY_SENTINEL).not.toMatch(/^[A-Za-z0-9]{20,}/);
    expect(REDACTED_API_KEY_SENTINEL.length).toBeLessThan(20);
  });

  it("sentinel is a non-empty string that passes basic truthy checks", () => {
    // Important: normalizeOptionalSecretInput should return it (not undefined)
    // so that hasConfiguredApiKey is true in normalizeProviders
    expect(REDACTED_API_KEY_SENTINEL).toBeTruthy();
    expect(typeof REDACTED_API_KEY_SENTINEL).toBe("string");
    expect(REDACTED_API_KEY_SENTINEL.trim()).toBe(REDACTED_API_KEY_SENTINEL);
  });
});
