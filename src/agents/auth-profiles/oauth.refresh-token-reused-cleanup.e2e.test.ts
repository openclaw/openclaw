import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
const oauthMocks = vi.hoisted(() => ({
  getOAuthApiKey: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai/oauth")>();
  return {
    ...actual,
    getOAuthApiKey: oauthMocks.getOAuthApiKey,
  };
});

import { resolveApiKeyForProfile } from "./oauth.js";
import { ensureAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

describe("resolveApiKeyForProfile refresh_token_reused cleanup", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tmpDir: string;
  let mainAgentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-reuse-cleanup-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });

    process.env.OPENCLAW_STATE_DIR = tmpDir;
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    oauthMocks.getOAuthApiKey.mockReset();
    envSnapshot.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes duplicate oauth profiles and clears failure state when refresh token is reused", async () => {
    const profileId = "openai-codex:default";
    const duplicateProfileId = "openai-codex:chatgpt-hprop17-subscription";
    const now = Date.now();

    const seededStore: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai-codex",
          email: "hprop17@gmail.com",
          access: "expired-access-default",
          refresh: "expired-refresh-default",
          expires: now - 60_000,
        },
        [duplicateProfileId]: {
          type: "oauth",
          provider: "openai-codex",
          email: "hprop17@gmail.com",
          access: "expired-access-duplicate",
          refresh: "expired-refresh-duplicate",
          expires: now - 120_000,
        },
      },
      usageStats: {
        [profileId]: {
          errorCount: 5,
          cooldownUntil: now + 300_000,
          failureCounts: { auth: 5 },
          lastFailureAt: now - 10_000,
        },
      },
    };
    await fs.writeFile(
      path.join(mainAgentDir, "auth-profiles.json"),
      JSON.stringify(seededStore),
      "utf8",
    );

    oauthMocks.getOAuthApiKey.mockRejectedValue(
      new Error(
        JSON.stringify({
          error: "invalid_grant",
          error_code: "refresh_token_reused",
          message: "refresh token has already been used",
        }),
      ),
    );

    const store = ensureAuthProfileStore(mainAgentDir);
    await expect(
      resolveApiKeyForProfile({
        store,
        profileId,
        agentDir: mainAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed/);

    const reloaded = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;

    expect(reloaded.profiles[duplicateProfileId]).toBeUndefined();
    expect(reloaded.profiles[profileId]).toBeDefined();
    expect(reloaded.usageStats?.[profileId]?.errorCount).toBe(0);
    expect(reloaded.usageStats?.[profileId]?.cooldownUntil).toBeUndefined();
    expect(reloaded.usageStats?.[profileId]?.disabledUntil).toBeUndefined();
    expect(reloaded.usageStats?.[profileId]?.failureCounts).toBeUndefined();
    expect(reloaded.usageStats?.[profileId]?.lastFailureAt).toBeUndefined();
  });
});
