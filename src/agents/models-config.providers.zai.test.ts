import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("ZAI provider", () => {
  const originalZaiApiKey = process.env.ZAI_API_KEY;
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalZaiApiKey === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = originalZaiApiKey;
    }
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includes zai provider when ZAI_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-zai-"));
    process.env.ZAI_API_KEY = "test-key";

    const providers = await resolveImplicitProviders({ agentDir });
    expect(providers?.zai).toBeDefined();
    expect(providers?.zai?.apiKey).toBe("ZAI_API_KEY");
    const ids = providers?.zai?.models?.map((model) => model.id) ?? [];
    expect(ids).toContain("glm-5");
  });

  it("discovers zai models from /models and filters non-glm ids", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-zai-"));
    process.env.ZAI_API_KEY = "test-key";

    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "glm-5" }, { id: "glm-4.6" }, { id: "embedding-3" }],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const providers = await resolveImplicitProviders({
      agentDir,
      allowTestProviderDiscovery: true,
    });
    const ids = providers?.zai?.models?.map((model) => model.id);
    expect(ids).toEqual(["glm-5", "glm-4.6"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.z.ai/api/paas/v4/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer test-key",
        }),
      }),
    );
  });
});
