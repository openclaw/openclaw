import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenAICodexCliExecution } from "./openai-codex-cli-bridge.js";

describe("prepareOpenAICodexCliExecution", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a private CODEX_HOME bridge from canonical OpenClaw oauth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-bridge-"));
    tempDirs.push(agentDir);

    const result = await prepareOpenAICodexCliExecution({
      config: undefined,
      workspaceDir: agentDir,
      agentDir,
      provider: "codex-cli",
      modelId: "gpt-5.4",
      authProfileId: "openai-codex:default",
      authCredential: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct-123",
      },
    });

    expect(result).toMatchObject({
      env: {
        CODEX_HOME: expect.stringContaining(path.join(agentDir, "cli-auth", "codex")),
      },
      clearEnv: ["OPENAI_API_KEY"],
    });

    const authFile = JSON.parse(
      await fs.readFile(path.join(result?.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
    );
    expect(authFile).toEqual({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        account_id: "acct-123",
      },
    });
  });

  it("returns null when there is no bridgeable canonical oauth credential", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cli-bridge-"));
    tempDirs.push(agentDir);

    await expect(
      prepareOpenAICodexCliExecution({
        config: undefined,
        workspaceDir: agentDir,
        agentDir,
        provider: "codex-cli",
        modelId: "gpt-5.4",
        authProfileId: "openai-codex:default",
        authCredential: {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-test",
        },
      }),
    ).resolves.toBeNull();
  });
});
