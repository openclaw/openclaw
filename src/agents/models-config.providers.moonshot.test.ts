import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("moonshot implicit provider", () => {
  const createAgentDir = () => mkdtempSync(join(tmpdir(), "openclaw-test-"));

  it("preserves explicit moonshot baseUrl on implicit provider injection", async () => {
    const agentDir = createAgentDir();
    process.env.MOONSHOT_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          moonshot: {
            baseUrl: "https://api.moonshot.cn/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });

      expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
      expect(providers?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY");
    } finally {
      delete process.env.MOONSHOT_API_KEY;
    }
  });
});
