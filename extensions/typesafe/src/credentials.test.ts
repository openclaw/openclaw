import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig } from "./credentials.js";
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
beforeEach(() => vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1 }));
describe("prepared capability credentials", () => {
  it("observes prepared rotation and unavailability without caching", () => {
    for (const [revision, value] of [
      "synthetic-A",
      "synthetic-B",
      undefined,
      "synthetic-C",
    ].entries()) {
      vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision, value });
      expect(resolveRuntimeConfig({}).apiKey).toBe(value);
    }
    expect(getPreparedPluginSecretInput).toHaveBeenLastCalledWith("typesafe", "apiKey");
  });
  it("does not use ambient or materialized source credentials without preparation", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-ambient");
    try {
      expect(
        resolveRuntimeConfig({
          plugins: { entries: { typesafe: { config: { apiKey: "synthetic-unprepared" } } } },
        }).apiKey,
      ).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("validates configuration before reading credentials", () => {
    vi.mocked(getPreparedPluginSecretInput).mockClear();
    expect(() =>
      resolveRuntimeConfig({ plugins: { entries: { typesafe: { config: { timeoutMs: -1 } } } } }),
    ).toThrow("Invalid TypeSafe configuration");
    expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
  });
});
