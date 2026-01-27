import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore } from "./types.js";

describe("resolveApiKeyForProfile", () => {
  let tmpDir: string;
  let mainAgentDir: string;
  let secondaryAgentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oauth-test-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    secondaryAgentDir = path.join(tmpDir, "agents", "kids", "agent");
    await fs.promises.mkdir(mainAgentDir, { recursive: true });
    await fs.promises.mkdir(secondaryAgentDir, { recursive: true });

    // Set env to use our temp dir
    process.env.CLAWDBOT_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.CLAWDBOT_STATE_DIR;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("falls back to main agent credentials when secondary agent token is expired and refresh fails", async () => {
    const profileId = "anthropic:claude-cli";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago
    const freshTime = now + 60 * 60 * 1000; // 1 hour from now

    // Write expired credentials for secondary agent
    const secondaryStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: expiredTime,
        },
      },
    };
    await fs.promises.writeFile(
      path.join(secondaryAgentDir, "auth-profiles.json"),
      JSON.stringify(secondaryStore),
    );

    // Write fresh credentials for main agent
    const mainStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "fresh-access-token",
          refresh: "fresh-refresh-token",
          expires: freshTime,
        },
      },
    };
    await fs.promises.writeFile(
      path.join(mainAgentDir, "auth-profiles.json"),
      JSON.stringify(mainStore),
    );

    // The secondary agent should fall back to main agent's credentials
    // when its own token refresh fails
    const result = await resolveApiKeyForProfile({
      store: secondaryStore,
      profileId,
      agentDir: secondaryAgentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("fresh-access-token");
    expect(result?.provider).toBe("anthropic");

    // Verify the credentials were copied to the secondary agent
    const updatedSecondaryStore = JSON.parse(
      await fs.promises.readFile(path.join(secondaryAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(updatedSecondaryStore.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      expires: freshTime,
    });
  });
});
