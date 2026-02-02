import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("AIMLAPI provider", () => {
  let previousAimlapiKey: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    previousAimlapiKey = process.env.AIMLAPI_API_KEY;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-aimlapi-test-"));
  });

  afterEach(async () => {
    if (previousAimlapiKey === undefined) {
      delete process.env.AIMLAPI_API_KEY;
    } else {
      process.env.AIMLAPI_API_KEY = previousAimlapiKey;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should not include aimlapi when no API key is configured", async () => {
    delete process.env.AIMLAPI_API_KEY;

    const providers = await resolveImplicitProviders({ agentDir: tempDir });

    expect(providers?.aimlapi).toBeUndefined();
  });

  it("should include aimlapi when AIMLAPI_API_KEY is set", async () => {
    process.env.AIMLAPI_API_KEY = "test-aimlapi-key";

    const providers = await resolveImplicitProviders({ agentDir: tempDir });

    expect(providers?.aimlapi).toBeDefined();
    expect(providers?.aimlapi?.apiKey).toBe("AIMLAPI_API_KEY");
    expect(providers?.aimlapi?.baseUrl).toBe("https://api.aimlapi.com/v1");
    expect(providers?.aimlapi?.api).toBe("openai-completions");
    expect(Array.isArray(providers?.aimlapi?.models)).toBe(true);
  });

  it("should include aimlapi when auth profile is configured", async () => {
    const authProfilesPath = path.join(tempDir, "auth-profiles.json");
    await fs.writeFile(
      authProfilesPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "aimlapi:default": {
            type: "api_key",
            provider: "aimlapi",
            key: "profile-aimlapi-key",
          },
        },
      }),
      "utf8",
    );

    const providers = await resolveImplicitProviders({ agentDir: tempDir });

    expect(providers?.aimlapi).toBeDefined();
    expect(providers?.aimlapi?.apiKey).toBe("profile-aimlapi-key");
    expect(providers?.aimlapi?.baseUrl).toBe("https://api.aimlapi.com/v1");
    expect(providers?.aimlapi?.api).toBe("openai-completions");
  });

  it("should prefer env var over auth profile", async () => {
    process.env.AIMLAPI_API_KEY = "env-aimlapi-key";

    const authProfilesPath = path.join(tempDir, "auth-profiles.json");
    await fs.writeFile(
      authProfilesPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "aimlapi:default": {
            type: "api_key",
            provider: "aimlapi",
            key: "profile-aimlapi-key",
          },
        },
      }),
      "utf8",
    );

    const providers = await resolveImplicitProviders({ agentDir: tempDir });

    expect(providers?.aimlapi?.apiKey).toBe("AIMLAPI_API_KEY");
  });
});
