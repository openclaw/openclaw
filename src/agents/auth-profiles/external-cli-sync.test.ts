import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./types.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";

function makeStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return {
    version: 1,
    profiles,
  };
}

describe("syncExternalCliCredentials — Claude CLI", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-sync-test-"));
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalHome !== undefined) {
      process.env.USERPROFILE = originalHome;
    } else {
      delete process.env.USERPROFILE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeClaudeCredentials(credentials: Record<string, unknown>): void {
    const claudeDir = path.join(tempDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify(credentials));
  }

  it("imports full OAuth credentials from Claude CLI", () => {
    const futureExpiry = Date.now() + 8 * 60 * 60 * 1000;
    writeClaudeCredentials({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test-access",
        refreshToken: "sk-ant-ort01-test-refresh",
        expiresAt: futureExpiry,
        scopes: ["user:inference", "user:profile"],
      },
    });

    const store = makeStore();
    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    const profile = store.profiles["anthropic:claude-cli"];
    expect(profile).toBeDefined();
    expect(profile?.type).toBe("oauth");
    expect(profile?.provider).toBe("anthropic");
    if (profile?.type === "oauth") {
      expect(profile.access).toBe("sk-ant-oat01-test-access");
      expect(profile.refresh).toBe("sk-ant-ort01-test-refresh");
      expect(profile.expires).toBe(futureExpiry);
    }
  });

  it("imports setup-token credentials (no refresh token)", () => {
    const futureExpiry = Date.now() + 8 * 60 * 60 * 1000;
    writeClaudeCredentials({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-setup-token",
        // No refreshToken — this is a setup-token
        expiresAt: futureExpiry,
      },
    });

    const store = makeStore();
    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    const profile = store.profiles["anthropic:claude-cli"];
    expect(profile).toBeDefined();
    expect(profile?.type).toBe("token");
    if (profile?.type === "token") {
      expect(profile.token).toBe("sk-ant-oat01-setup-token");
    }
  });

  it("updates expired OAuth profile with fresher credentials", () => {
    const freshExpiry = Date.now() + 8 * 60 * 60 * 1000;
    writeClaudeCredentials({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-new-access",
        refreshToken: "sk-ant-ort01-new-refresh",
        expiresAt: freshExpiry,
      },
    });

    const expiredTime = Date.now() - 60 * 1000;
    const store = makeStore({
      "anthropic:claude-cli": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-old-access",
        refresh: "sk-ant-ort01-old-refresh",
        expires: expiredTime,
      },
    });

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    const profile = store.profiles["anthropic:claude-cli"];
    if (profile?.type === "oauth") {
      expect(profile.access).toBe("sk-ant-oat01-new-access");
      expect(profile.refresh).toBe("sk-ant-ort01-new-refresh");
    }
  });

  it("skips sync when existing profile is still fresh", () => {
    // Don't write any credential file — should not even try to read
    const freshExpiry = Date.now() + 2 * 60 * 60 * 1000;
    const store = makeStore({
      "anthropic:claude-cli": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-existing",
        refresh: "sk-ant-ort01-existing",
        expires: freshExpiry,
      },
    });

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    // Profile should be unchanged
    if (store.profiles["anthropic:claude-cli"]?.type === "oauth") {
      expect(store.profiles["anthropic:claude-cli"].access).toBe("sk-ant-oat01-existing");
    }
  });

  it("upgrades existing token profile to OAuth when CLI has OAuth credentials", () => {
    const freshExpiry = Date.now() + 8 * 60 * 60 * 1000;
    writeClaudeCredentials({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-oauth-access",
        refreshToken: "sk-ant-ort01-oauth-refresh",
        expiresAt: freshExpiry,
        scopes: ["user:inference", "user:profile"],
      },
    });

    // Existing token profile that is still fresh (not near expiry)
    const store = makeStore({
      "anthropic:claude-cli": {
        type: "token",
        provider: "anthropic",
        token: "sk-ant-oat01-setup-token",
        expires: Date.now() + 4 * 60 * 60 * 1000,
      },
    });

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    const profile = store.profiles["anthropic:claude-cli"];
    expect(profile?.type).toBe("oauth");
    if (profile?.type === "oauth") {
      expect(profile.access).toBe("sk-ant-oat01-oauth-access");
      expect(profile.refresh).toBe("sk-ant-ort01-oauth-refresh");
    }
  });

  it("does not mutate when no Claude CLI credentials exist", () => {
    // No .claude directory at all
    const store = makeStore();
    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(store.profiles["anthropic:claude-cli"]).toBeUndefined();
  });
});
