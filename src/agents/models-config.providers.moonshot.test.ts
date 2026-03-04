import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("moonshot implicit provider", () => {
  const createAgentDir = () => mkdtempSync(join(tmpdir(), "openclaw-test-"));

  it("uses the default api.moonshot.ai baseUrl when none is configured", async () => {
    const agentDir = createAgentDir();
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.moonshot).toBeDefined();
      expect(providers?.moonshot?.baseUrl).toBe("https://api.moonshot.ai/v1");
      expect(providers?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("respects an explicit baseUrl for CN users (api.moonshot.cn)", async () => {
    const agentDir = createAgentDir();
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
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
    } finally {
      envSnapshot.restore();
    }
  });

  it("does not include moonshot when no API key is configured", async () => {
    const agentDir = createAgentDir();
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    delete process.env.MOONSHOT_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.moonshot).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
