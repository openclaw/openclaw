import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Upstage provider", () => {
  it("should include upstage when UPSTAGE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ UPSTAGE_API_KEY: "test-key" }, async () => {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.upstage).toBeDefined();
      expect(providers?.upstage?.apiKey).toBe("UPSTAGE_API_KEY");
    });
  });
});
