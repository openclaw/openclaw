// Covers API-key discovery from environment and key files.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, withEnvAsync } from "../../../src/test-utils/env.js";

const envKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
] as const;

const originalEnv = captureEnv([...envKeys]);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  originalEnv.restore();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.resetModules();
});

describe("getEnvApiKey", () => {
  it("returns no env auth in browser contexts without process", async () => {
    vi.resetModules();
    const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");
    vi.stubGlobal("process", undefined);

    expect(findEnvKeys("openai")).toBeUndefined();
    expect(getEnvApiKey("openai")).toBeUndefined();
    expect(getEnvApiKey("google-vertex")).toBeUndefined();
    expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
  });

  it("skips blank API keys and trims the selected fallback", async () => {
    const env = {
      ANTHROPIC_OAUTH_TOKEN: "  ",
      OPENAI_API_KEY: " \t ",
    } as NodeJS.ProcessEnv;
    Reflect.set(env, "ANTHROPIC_API_KEY", "  test-anthropic-key  ");

    await withEnvAsync(env, async () => {
      vi.resetModules();
      const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");

      expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
      expect(getEnvApiKey("anthropic")).toBe("test-anthropic-key");
      expect(findEnvKeys("openai")).toBeUndefined();
      expect(getEnvApiKey("openai")).toBeUndefined();
    });
  });

  it("keeps non-blank AWS profile authentication available", async () => {
    await withEnvAsync({ AWS_PROFILE: "  production  " }, async () => {
      vi.resetModules();
      const { getEnvApiKey } = await import("./env-api-keys.js");

      expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
    });
  });

  it("does not cache missing Google Vertex ADC credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await withEnvAsync(
      {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      },
      async () => {
        vi.resetModules();
        const { getEnvApiKey } = await import("./env-api-keys.js");

        expect(getEnvApiKey("google-vertex")).toBeUndefined();
        await writeFile(credentialsPath, "{}", "utf-8");
        expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
      },
    );
  });
});
