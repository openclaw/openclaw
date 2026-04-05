import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let resetCliCredentialCachesForTest: typeof import("./cli-credentials.js").resetCliCredentialCachesForTest;
let readCodexCliCredentials: typeof import("./cli-credentials.js").readCodexCliCredentials;
let writeCodexCliCredentials: typeof import("./cli-credentials.js").writeCodexCliCredentials;
let writeCodexCliFileCredentials: typeof import("./cli-credentials.js").writeCodexCliFileCredentials;

function getAddGenericPasswordCall() {
  return execFileSyncMock.mock.calls.find(
    ([binary, args]) =>
      String(binary) === "security" &&
      Array.isArray(args) &&
      (args as unknown[]).map(String).includes("add-generic-password"),
  );
}

function createJwtWithExp(expSeconds: number): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

describe("cli credentials", () => {
  beforeAll(async () => {
    ({
      readCodexCliCredentialsCached,
      resetCliCredentialCachesForTest,
      readCodexCliCredentials,
      writeCodexCliCredentials,
      writeCodexCliFileCredentials,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    execFileSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    resetCliCredentialCachesForTest();
  });

  it("reads Codex credentials from keychain when available", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-23T00:48:49Z") / 1000);

    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentials({ platform: "darwin", execSync: execSyncMock });

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
    execSyncMock.mockImplementation(() => {
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

    const creds = readCodexCliCredentials({ execSync: execSyncMock });

    expect(creds).toMatchObject({
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai-codex",
      expires: expSeconds * 1000,
    });
  });

  it("invalidates cached Codex credentials when auth.json changes within the TTL window", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    const firstExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const secondExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    try {
      fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(firstExpiry),
            refresh_token: "stale-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:00:00Z"), new Date("2026-03-24T10:00:00Z"));
      vi.setSystemTime(new Date("2026-03-24T10:00:00Z"));

      const first = readCodexCliCredentialsCached({
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
        platform: "linux",
        execSync: execSyncMock,
      });

      expect(first).toMatchObject({
        refresh: "stale-refresh",
        expires: firstExpiry * 1000,
      });

      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(secondExpiry),
            refresh_token: "fresh-refresh",
          },
        }),
        "utf8",
      );
      fs.utimesSync(authPath, new Date("2026-03-24T10:05:00Z"), new Date("2026-03-24T10:05:00Z"));
      vi.advanceTimersByTime(60_000);

      const second = readCodexCliCredentialsCached({
        ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
        platform: "linux",
        execSync: execSyncMock,
      });

      expect(second).toMatchObject({
        refresh: "fresh-refresh",
        expires: secondExpiry * 1000,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("updates existing Codex auth.json in place", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-write-"));
    process.env.CODEX_HOME = tempHome;
    try {
      fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
      const authPath = path.join(tempHome, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify(
          {
            auth_mode: "chatgpt",
            OPENAI_API_KEY: "sk-existing",
            tokens: {
              id_token: "id-token",
              access_token: "old-access",
              refresh_token: "old-refresh",
              account_id: "acct-old",
            },
            last_refresh: "2026-03-01T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const ok = writeCodexCliFileCredentials({
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60_000,
        accountId: "acct-new",
      });

      expect(ok).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-existing",
      });
      expect(persisted.tokens).toMatchObject({
        id_token: "id-token",
        access_token: "new-access",
        refresh_token: "new-refresh",
        account_id: "acct-new",
      });
      expect(typeof persisted.last_refresh).toBe("string");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("prefers the existing Codex keychain entry over auth.json on darwin writes", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-keychain-write-"));
    process.env.CODEX_HOME = tempHome;
    try {
      const expSeconds = Math.floor(Date.parse("2026-03-26T12:34:56Z") / 1000);
      execSyncMock.mockImplementation((command: unknown) => {
        const cmd = String(command);
        expect(cmd).toContain("Codex Auth");
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            id_token: "id-token",
            access_token: createJwtWithExp(expSeconds),
            refresh_token: "old-refresh",
            account_id: "acct-old",
          },
          last_refresh: "2026-03-01T00:00:00.000Z",
        });
      });

      const ok = writeCodexCliCredentials(
        {
          access: "new-access",
          refresh: "new-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-new",
        },
        {
          platform: "darwin",
          execSync: execSyncMock,
          execFileSync: execFileSyncMock,
        },
      );

      expect(ok).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const addCall = getAddGenericPasswordCall();
      expect(addCall?.[0]).toBe("security");
      const payload = (() => {
        const args = (addCall?.[1] as string[] | undefined) ?? [];
        const valueIndex = args.indexOf("-w");
        return valueIndex >= 0 ? args[valueIndex + 1] : undefined;
      })();
      expect(payload).toBeDefined();
      const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
      expect(parsed.tokens).toMatchObject({
        id_token: "id-token",
        access_token: "new-access",
        refresh_token: "new-refresh",
        account_id: "acct-new",
      });
      expect(parsed.auth_mode).toBe("chatgpt");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
