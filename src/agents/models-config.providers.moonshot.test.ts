import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Moonshot implicit provider", () => {
  it("preserves explicit moonshot baseUrl when auth is inferred", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ MOONSHOT_API_KEY: "moonshot-test-key" }, async () => {
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

      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
      expect(providers?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY");
    });
  });
});
