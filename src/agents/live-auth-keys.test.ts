import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../plugins/manifest-registry.js");
vi.unmock("../secrets/provider-env-vars.js");

const ORIGINAL_MODELSTUDIO_API_KEY = process.env.MODELSTUDIO_API_KEY;
const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;
let collectProviderApiKeys: typeof import("./live-auth-keys.js").collectProviderApiKeys;
let clearPluginManifestRegistryCache: typeof import("../plugins/manifest-registry.js").clearPluginManifestRegistryCache;

async function loadModulesForTest(): Promise<void> {
  ({ clearPluginManifestRegistryCache } = await import("../plugins/manifest-registry.js"));
  ({ collectProviderApiKeys } = await import("./live-auth-keys.js"));
}

function clearManifestRegistryCache(): void {
  clearPluginManifestRegistryCache();
}

describe("collectProviderApiKeys", () => {
  beforeAll(async () => {
    vi.doUnmock("../plugins/manifest-registry.js");
    vi.doUnmock("../secrets/provider-env-vars.js");
    await loadModulesForTest();
  });

  beforeEach(() => {
    clearManifestRegistryCache();
  });

  afterEach(() => {
    clearManifestRegistryCache();
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

    expect(collectProviderApiKeys("alibaba")).toContain("modelstudio-live-key");
  });

  it("dedupes manifest env vars against direct provider env naming", async () => {
    process.env.XAI_API_KEY = "xai-live-key";

    expect(collectProviderApiKeys("xai")).toEqual(["xai-live-key"]);
  });
});
