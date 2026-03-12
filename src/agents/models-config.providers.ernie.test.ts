import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

const ernieApiKeyEnv = ["ERNIE_API", "KEY"].join("_");

describe("ERNIE provider", () => {
  it("should include ernie when ERNIE_API_KEY is configured", async () => {
    // pragma: allowlist secret
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const ernieApiKey = "test-key"; // pragma: allowlist secret
    await withEnvAsync({ [ernieApiKeyEnv]: ernieApiKey }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.ernie).toBeDefined();
      expect(providers?.ernie?.apiKey).toBe("ERNIE_API_KEY");
    });
  });
});
