import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Aliyun Bailian provider", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("should not include aliyun-bailian when no API key is configured", async () => {
    const providers = await resolveImplicitProviders({ agentDir });
    expect(providers?.["aliyun-bailian"]).toBeUndefined();
  });

  it("should include aliyun-bailian when API key is configured via environment variable", async () => {
    vi.stubEnv("ALIYUN_BAILIAN_API_KEY", "test-key");

    // Mock the discovery fetch call
    const mockModels = {
      data: [{ id: "qwen-max" }, { id: "qwen-vl-plus" }],
    };

    const globalFetch = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockModels,
    } as Response);

    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.["aliyun-bailian"]).toBeDefined();
    expect(providers?.["aliyun-bailian"]?.apiKey).toBe("ALIYUN_BAILIAN_API_KEY");
    expect(providers?.["aliyun-bailian"]?.models).toHaveLength(2);
    expect(providers?.["aliyun-bailian"]?.models[0].id).toBe("qwen-max");
    expect(providers?.["aliyun-bailian"]?.models[1].input).toContain("image");

    globalFetch.mockRestore();
  });
});
