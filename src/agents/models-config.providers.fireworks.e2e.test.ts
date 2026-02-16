import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildFireworksProvider, resolveImplicitProviders } from "./models-config.providers.js";

describe("Fireworks provider", () => {
  it("should include fireworks when FIREWORKS_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["FIREWORKS_API_KEY"]);
    process.env.FIREWORKS_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.fireworks).toBeDefined();
      expect(providers?.fireworks?.apiKey).toBe("FIREWORKS_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build fireworks provider with expected defaults", () => {
    const provider = buildFireworksProvider();
    expect(provider.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "accounts/fireworks/models/llama-v3p1-8b-instruct",
          name: "Llama 3.1 8B Instruct",
        }),
      ]),
    );
  });
});
