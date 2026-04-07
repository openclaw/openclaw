import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_MODELSTUDIO_API_KEY = process.env.MODELSTUDIO_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;

async function clearManifestRegistryCache(): Promise<void> {
  const { clearPluginManifestRegistryCache } = await import("../plugins/manifest-registry.js");
  clearPluginManifestRegistryCache();
}

describe("collectProviderApiKeys", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../plugins/manifest-registry.js");
    vi.doUnmock("../secrets/provider-env-vars.js");
    await clearManifestRegistryCache();
  });

  afterEach(async () => {
    vi.resetModules();
    await clearManifestRegistryCache();
    if (ORIGINAL_MODELSTUDIO_API_KEY === undefined) {
      delete process.env.MODELSTUDIO_API_KEY;
    } else {
      process.env.MODELSTUDIO_API_KEY = ORIGINAL_MODELSTUDIO_API_KEY;
    }
    if (ORIGINAL_XAI_API_KEY === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = ORIGINAL_XAI_API_KEY;
    }
  });

  it("honors manifest-declared provider auth env vars for nonstandard provider ids", async () => {
    process.env.MODELSTUDIO_API_KEY = "modelstudio-live-key";
    vi.resetModules();
    const { collectProviderApiKeys } = await import("./live-auth-keys.js");

    expect(collectProviderApiKeys("alibaba")).toContain("modelstudio-live-key");
  });

  it("dedupes manifest env vars against direct provider env naming", async () => {
    process.env.XAI_API_KEY = "xai-live-key";
    vi.resetModules();
    const { collectProviderApiKeys } = await import("./live-auth-keys.js");

    expect(collectProviderApiKeys("xai")).toEqual(["xai-live-key"]);
  });
});
