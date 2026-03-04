import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("moonshot implicit provider", () => {
  it("uses the default .ai baseUrl when no explicit moonshot provider is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["MOONSHOT_API_KEY"]);
    process.env.MOONSHOT_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers.moonshot?.baseUrl).toBe("https://api.moonshot.ai/v1");
    } finally {
      envSnapshot.restore();
    }
  });

  it("preserves explicit moonshot baseUrl on implicit provider injection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
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
      expect(providers.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
    } finally {
      envSnapshot.restore();
    }
  });
});
