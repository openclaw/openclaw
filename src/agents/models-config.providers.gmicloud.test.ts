import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

const gmicloudApiKeyEnv = "GMI_CLOUD_API_KEY";

describe("GMI Cloud provider", () => {
  it("should include gmicloud when GMI_CLOUD_API_KEY is configured", async () => {
    // pragma: allowlist secret
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const gmicloudApiKey = "test-key"; // pragma: allowlist secret
    await withEnvAsync({ [gmicloudApiKeyEnv]: gmicloudApiKey }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.gmicloud).toBeDefined();
      expect(providers?.gmicloud?.apiKey).toBe("GMI_CLOUD_API_KEY");
    });
  });
});
