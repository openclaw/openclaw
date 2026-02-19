import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEdgeeProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("Edgee provider", () => {
  it("buildEdgeeProvider returns OpenAI-compatible provider config", () => {
    const provider = buildEdgeeProvider();
    expect(provider.baseUrl).toBe("https://api.edgee.ai/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.some((m) => m.id === "openai/gpt-4o")).toBe(true);
  });

  it("adds implicit edgee provider when EDGEE_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-edgee-"));
    const previous = process.env.EDGEE_API_KEY;
    process.env.EDGEE_API_KEY = "edgee-test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.edgee).toBeDefined();
      expect(providers?.edgee?.baseUrl).toBe("https://api.edgee.ai/v1");
      expect(providers?.edgee?.api).toBe("openai-completions");
      expect(providers?.edgee?.apiKey).toBe("EDGEE_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.EDGEE_API_KEY;
      } else {
        process.env.EDGEE_API_KEY = previous;
      }
    }
  });
});
