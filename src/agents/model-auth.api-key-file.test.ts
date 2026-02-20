import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getCustomProviderApiKey } from "./model-auth.js";

function makeConfig(providerEntry: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        custom: { baseUrl: "https://api.example.com", models: [], ...providerEntry },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("getCustomProviderApiKey with apiKeyFile", () => {
  let tmpDir: string;
  let keyFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    keyFile = path.join(tmpDir, "api-key");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads API key from apiKeyFile", () => {
    fs.writeFileSync(keyFile, "sk-file-key-12345\n");
    const cfg = makeConfig({ apiKeyFile: keyFile });
    expect(getCustomProviderApiKey(cfg, "custom")).toBe("sk-file-key-12345");
  });

  it("apiKeyFile takes precedence over apiKey", () => {
    fs.writeFileSync(keyFile, "sk-from-file\n");
    const cfg = makeConfig({ apiKey: "sk-from-config", apiKeyFile: keyFile });
    expect(getCustomProviderApiKey(cfg, "custom")).toBe("sk-from-file");
  });

  it("apiKeyFile takes precedence even when apiKey is the placeholder", () => {
    fs.writeFileSync(keyFile, "sk-real-secret\n");
    const cfg = makeConfig({ apiKey: "__apiKeyFile__", apiKeyFile: keyFile });
    expect(getCustomProviderApiKey(cfg, "custom")).toBe("sk-real-secret");
  });

  it("returns undefined when apiKeyFile does not exist", () => {
    const cfg = makeConfig({ apiKeyFile: "/nonexistent/path/key" });
    expect(getCustomProviderApiKey(cfg, "custom")).toBeUndefined();
  });

  it("returns undefined when apiKeyFile is empty", () => {
    fs.writeFileSync(keyFile, "  \n");
    const cfg = makeConfig({ apiKeyFile: keyFile });
    expect(getCustomProviderApiKey(cfg, "custom")).toBeUndefined();
  });

  it("falls back to apiKey when apiKeyFile is not set", () => {
    const cfg = makeConfig({ apiKey: "sk-inline-key" });
    expect(getCustomProviderApiKey(cfg, "custom")).toBe("sk-inline-key");
  });
});
