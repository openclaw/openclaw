import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: vi.fn(() => ({
    plugins: [
      {
        id: "openrouter",
        origin: "bundled",
        providerAuthEnvVars: {
          openrouter: ["OPENROUTER_API_KEY"],
        },
      },
    ],
    diagnostics: [],
  })),
}));

describe("model-auth-env-vars", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("PROVIDER_ENV_API_KEY_CANDIDATES resolves openrouter env var", async () => {
    const mod = await import("./model-auth-env-vars.js");
    expect(mod.PROVIDER_ENV_API_KEY_CANDIDATES.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("resolveProviderEnvApiKeyCandidates returns openrouter env var", async () => {
    const mod = await import("./model-auth-env-vars.js");
    const candidates = mod.resolveProviderEnvApiKeyCandidates();
    expect(candidates.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("PROVIDER_ENV_API_KEY_CANDIDATES is lazy-loaded", async () => {
    const { loadPluginManifestRegistry } = await import("../plugins/manifest-registry.js");
    vi.clearAllMocks();

    // Import the module but don't access PROVIDER_ENV_API_KEY_CANDIDATES yet
    const modPromise = import("./model-auth-env-vars.js");

    // The manifest registry should NOT have been called yet
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();

    // Now access the lazy export
    const mod = await modPromise;
    void mod.PROVIDER_ENV_API_KEY_CANDIDATES.openrouter;

    // Now the manifest registry should have been called
    expect(loadPluginManifestRegistry).toHaveBeenCalled();
  });
});