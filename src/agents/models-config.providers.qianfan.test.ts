import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

const qianfanApiKeyEnv = ["QIANFAN_API", "KEY"].join("_");

describe("Qianfan provider", () => {
  it("should include qianfan when QIANFAN_API_KEY is configured", async () => {
    // pragma: allowlist secret
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const qianfanApiKey = "test-key"; // pragma: allowlist secret
    await withEnvAsync({ [qianfanApiKeyEnv]: qianfanApiKey }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.qianfan).toBeDefined();
      expect(providers?.qianfan?.apiKey).toBe("QIANFAN_API_KEY");
    });
  });
});
