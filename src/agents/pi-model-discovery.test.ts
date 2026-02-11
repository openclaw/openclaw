import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-profiles/store.js", () => ({
  ensureAuthProfileStore: vi.fn(),
}));

import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { discoverAuthStorage } from "./pi-model-discovery.js";

describe("discoverAuthStorage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers auth from auth-profiles.json when auth.json is absent", () => {
    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-test-key",
        },
      },
    });

    // auth.json does NOT exist — this is the exact bug scenario from #12088
    expect(fs.existsSync(path.join(tempDir, "auth.json"))).toBe(false);

    const storage = discoverAuthStorage(tempDir);
    expect(storage.has("anthropic")).toBe(true);
  });

  it("converts token credentials to api_key format for pi-sdk", () => {
    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-test-key",
        },
      },
    });

    discoverAuthStorage(tempDir);

    const authJson = JSON.parse(fs.readFileSync(path.join(tempDir, "auth.json"), "utf-8"));
    expect(authJson.anthropic).toEqual({
      type: "api_key",
      key: "sk-ant-test-key",
    });
  });

  it("picks lastGood profile when multiple profiles exist", () => {
    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "default-key",
        },
        "anthropic:premium": {
          type: "token",
          provider: "anthropic",
          token: "premium-key",
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "openai-key",
        },
      },
      lastGood: { anthropic: "anthropic:premium" },
    });

    discoverAuthStorage(tempDir);

    const authJson = JSON.parse(fs.readFileSync(path.join(tempDir, "auth.json"), "utf-8"));
    expect(authJson.anthropic).toEqual({
      type: "api_key",
      key: "premium-key",
    });
    expect(authJson.openai).toEqual({ type: "api_key", key: "openai-key" });
  });

  it("preserves OAuth credential fields", () => {
    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: 9999999999999,
        },
      },
    });

    discoverAuthStorage(tempDir);

    const authJson = JSON.parse(fs.readFileSync(path.join(tempDir, "auth.json"), "utf-8"));
    expect(authJson.anthropic).toEqual({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 9999999999999,
    });
  });

  it("handles empty auth-profiles gracefully", () => {
    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {},
    });

    const storage = discoverAuthStorage(tempDir);
    expect(storage.has("anthropic")).toBe(false);
  });

  it("does not overwrite existing auth.json when auth-profiles is empty", () => {
    // Pre-existing auth.json with valid credentials (pre-migration scenario)
    const authJsonPath = path.join(tempDir, "auth.json");
    const existing = { anthropic: { type: "api_key", key: "pre-existing-key" } };
    fs.writeFileSync(authJsonPath, JSON.stringify(existing), "utf-8");

    vi.mocked(ensureAuthProfileStore).mockReturnValue({
      version: 1,
      profiles: {},
    });

    const storage = discoverAuthStorage(tempDir);
    // The pre-existing credentials should be preserved
    expect(storage.has("anthropic")).toBe(true);

    const authJson = JSON.parse(fs.readFileSync(authJsonPath, "utf-8"));
    expect(authJson.anthropic.key).toBe("pre-existing-key");
  });
});
