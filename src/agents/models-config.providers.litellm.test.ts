import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("LiteLLM provider", () => {
  it("should include litellm when LITELLM_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.LITELLM_API_KEY;
    const previousBaseUrl = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_API_KEY = "test-key";
    process.env.LITELLM_BASE_URL = "http://localhost:4000";

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.litellm).toBeDefined();
      expect(providers?.litellm?.apiKey).toBe("LITELLM_API_KEY");
      expect(providers?.litellm?.baseUrl).toBe("http://localhost:4000");
      expect(providers?.litellm?.api).toBe("openai-completions");
    } finally {
      if (previous === undefined) {
        delete process.env.LITELLM_API_KEY;
      } else {
        process.env.LITELLM_API_KEY = previous;
      }
      if (previousBaseUrl === undefined) {
        delete process.env.LITELLM_BASE_URL;
      } else {
        process.env.LITELLM_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("should use default base URL when only LITELLM_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.LITELLM_API_KEY;
    const previousBaseUrl = process.env.LITELLM_BASE_URL;
    process.env.LITELLM_API_KEY = "test-key";
    delete process.env.LITELLM_BASE_URL;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.litellm).toBeDefined();
      expect(providers?.litellm?.baseUrl).toBe("http://localhost:4000");
    } finally {
      if (previous === undefined) {
        delete process.env.LITELLM_API_KEY;
      } else {
        process.env.LITELLM_API_KEY = previous;
      }
      if (previousBaseUrl === undefined) {
        delete process.env.LITELLM_BASE_URL;
      } else {
        process.env.LITELLM_BASE_URL = previousBaseUrl;
      }
    }
  });

  it("should resolve litellm from auth profile with metadata baseUrl", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "litellm:default": {
            type: "api_key",
            provider: "litellm",
            key: "sk-litellm-test",
            metadata: {
              baseUrl: "https://my-litellm.example.com",
            },
          },
        },
      }),
    );

    const previous = process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.litellm).toBeDefined();
      expect(providers?.litellm?.baseUrl).toBe("https://my-litellm.example.com");
      expect(providers?.litellm?.apiKey).toBe("sk-litellm-test");
    } finally {
      if (previous === undefined) {
        delete process.env.LITELLM_API_KEY;
      } else {
        process.env.LITELLM_API_KEY = previous;
      }
    }
  });

  it("should not include litellm when no key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const previous = process.env.LITELLM_API_KEY;
    delete process.env.LITELLM_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.litellm).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.LITELLM_API_KEY;
      } else {
        process.env.LITELLM_API_KEY = previous;
      }
    }
  });
});
