import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Api, Model } from "@mariozechner/pi-ai";
import { discoverAuthStorage } from "@mariozechner/pi-coding-agent";

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct_123",
};

describe("getApiKeyForModel", () => {
  it("migrates legacy oauth.json into auth.json", async () => {
    const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-oauth-"),
    );

    try {
      process.env.CLAWDBOT_STATE_DIR = tempDir;

      const oauthDir = path.join(tempDir, "credentials");
      await fs.mkdir(oauthDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(oauthDir, "oauth.json"),
        `${JSON.stringify({ "openai-codex": oauthFixture }, null, 2)}\n`,
        "utf8",
      );

      const agentDir = path.join(tempDir, "agent");
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      const authStorage = discoverAuthStorage(agentDir);

      vi.resetModules();
      const { getApiKeyForModel } = await import("./model-auth.js");

      const model = {
        id: "codex-mini-latest",
        provider: "openai-codex",
        api: "openai-codex-responses",
      } as Model<Api>;

      const apiKey = await getApiKeyForModel(model, authStorage);
      expect(apiKey).toBe(oauthFixture.access);

      const authJson = await fs.readFile(
        path.join(agentDir, "auth.json"),
        "utf8",
      );
      const authData = JSON.parse(authJson) as Record<string, unknown>;
      expect(authData["openai-codex"]).toMatchObject({
        type: "oauth",
        access: oauthFixture.access,
        refresh: oauthFixture.refresh,
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = previousStateDir;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
