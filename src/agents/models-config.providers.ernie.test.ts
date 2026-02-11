import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("ERNIE provider", () => {
  it("should include ernie when ERNIE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.ERNIE_API_KEY;
    process.env.ERNIE_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.ernie).toBeDefined();
      expect(providers?.ernie?.apiKey).toBe("ERNIE_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.ERNIE_API_KEY;
      } else {
        process.env.ERNIE_API_KEY = previous;
      }
    }
  });
});
