import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAuthProfileStore, upsertAuthProfile } from "./auth-profiles.js";

describe("upsertAuthProfile OAuth cleanup", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes duplicate oauth profiles for the same provider/email and keeps the updated profile", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-cleanup-"));
    tempDirs.push(agentDir);
    const authPath = path.join(agentDir, "auth-profiles.json");

    fs.writeFileSync(
      authPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            email: "hprop17@gmail.com",
            access: "old-access-default",
            refresh: "old-refresh-default",
            expires: Date.now() - 1_000,
          },
          "openai-codex:chatgpt-hprop17-subscription": {
            type: "oauth",
            provider: "openai-codex",
            email: "hprop17@gmail.com",
            access: "old-access-duplicate",
            refresh: "old-refresh-duplicate",
            expires: Date.now() - 2_000,
          },
        },
        order: {
          "openai-codex": ["openai-codex:chatgpt-hprop17-subscription", "openai-codex:default"],
        },
        lastGood: {
          "openai-codex": "openai-codex:chatgpt-hprop17-subscription",
        },
        usageStats: {
          "openai-codex:chatgpt-hprop17-subscription": {
            errorCount: 3,
            cooldownUntil: Date.now() + 120_000,
          },
        },
      }),
    );

    upsertAuthProfile({
      profileId: "openai-codex:default",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        email: "hprop17@gmail.com",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 60_000,
      },
      agentDir,
    });

    const reloaded = ensureAuthProfileStore(agentDir);
    expect(reloaded.profiles["openai-codex:default"]).toMatchObject({
      access: "fresh-access",
      refresh: "fresh-refresh",
      email: "hprop17@gmail.com",
    });
    expect(reloaded.profiles["openai-codex:chatgpt-hprop17-subscription"]).toBeUndefined();
    expect(reloaded.usageStats?.["openai-codex:chatgpt-hprop17-subscription"]).toBeUndefined();
    expect(reloaded.order?.["openai-codex"]).toEqual(["openai-codex:default"]);
    expect(reloaded.lastGood?.["openai-codex"]).toBe("openai-codex:default");
  });
});
