import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Novita provider", () => {
  it("includes novita when NOVITA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.NOVITA_API_KEY;
    process.env.NOVITA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.novita).toBeDefined();
      expect(providers?.novita?.apiKey).toBe("NOVITA_API_KEY");
      expect(providers?.novita?.api).toBe("openai-completions");
      expect(Array.isArray(providers?.novita?.models)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.NOVITA_API_KEY;
      } else {
        process.env.NOVITA_API_KEY = previous;
      }
    }
  });
});
