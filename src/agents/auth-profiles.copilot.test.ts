import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
} from "./auth-profiles.js";

vi.mock("@mariozechner/pi-ai", () => ({
  getOAuthApiKey: vi.fn(() => {
    throw new Error("refresh should not be called");
  }),
}));

describe("auth-profiles (github-copilot)", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (previousStateDir === undefined) delete process.env.CLAWDBOT_STATE_DIR;
    else process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    if (previousAgentDir === undefined) delete process.env.CLAWDBOT_AGENT_DIR;
    else process.env.CLAWDBOT_AGENT_DIR = previousAgentDir;
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  });

  it("treats copilot oauth tokens with expires=0 as non-expiring", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-copilot-"));
    process.env.CLAWDBOT_STATE_DIR = tempDir;
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempDir, "agents", "main", "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

    const authProfilePath = path.join(tempDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(authProfilePath), { recursive: true });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "github-copilot:github": {
          type: "oauth",
          provider: "github-copilot",
          refresh: "gh-token",
          access: "gh-token",
          expires: 0,
          enterpriseUrl: "company.ghe.com",
        },
      },
    };
    await fs.writeFile(authProfilePath, `${JSON.stringify(store)}\n`);

    const loaded = ensureAuthProfileStore();
    const resolved = await resolveApiKeyForProfile({
      store: loaded,
      profileId: "github-copilot:github",
    });

    expect(resolved?.apiKey).toBe("gh-token");
  });
});
