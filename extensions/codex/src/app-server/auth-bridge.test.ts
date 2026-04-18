import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));

let bridgeCodexAppServerStartOptions: typeof import("./auth-bridge.js").bridgeCodexAppServerStartOptions;

describe("bridgeCodexAppServerStartOptions", () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    ({ bridgeCodexAppServerStartOptions } = await import("./auth-bridge.js"));
  });

  afterEach(async () => {
    mocks.ensureAuthProfileStore.mockReset();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("bridges canonical OpenClaw oauth into an isolated CODEX_HOME", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    tempDirs.push(agentDir);
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct-123",
        },
      },
    });

    const result = await bridgeCodexAppServerStartOptions({
      startOptions: {
        command: "codex",
        args: ["app-server"],
        headers: { authorization: "Bearer dev-token" },
        env: { EXISTING: "1" },
        clearEnv: ["FOO"],
      },
      agentDir,
    });

    expect(result).toMatchObject({
      env: {
        EXISTING: "1",
        CODEX_HOME: expect.stringContaining(path.join(agentDir, "harness-auth", "codex")),
      },
      clearEnv: expect.arrayContaining(["FOO", "OPENAI_API_KEY"]),
    });

    const authFile = JSON.parse(
      await fs.readFile(path.join(result.env?.CODEX_HOME ?? "", "auth.json"), "utf8"),
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

  it("leaves start options unchanged when canonical oauth is unavailable", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    tempDirs.push(agentDir);
    const startOptions = {
      command: "codex",
      args: ["app-server"],
      headers: { authorization: "Bearer dev-token" },
    };
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await expect(
      bridgeCodexAppServerStartOptions({
        startOptions,
        agentDir,
        authProfileId: "openai-codex:missing",
      }),
    ).resolves.toEqual(startOptions);
  });
});
