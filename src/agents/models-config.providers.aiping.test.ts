import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("AIPing provider", () => {
  it("should include aiping when AIPING_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync(
      { AIPING_API_KEY: "aiping-api-key" }, // pragma: allowlist secret
      async () => {
        const providers = await resolveImplicitProviders({ agentDir });
        expect(providers?.aiping).toBeDefined();
        expect(providers?.aiping?.apiKey).toBe("AIPING_API_KEY");
      },
    );
  });
});
