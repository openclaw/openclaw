/** Tests CLI credential parsing and cache expiry. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: execSyncMock,
}));
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let credentials: typeof import("./cli-credentials.js");

function createJwtWithExp(expSeconds: number): string {
  // Signature verification is out of scope; expiration extraction only needs a
  // syntactically valid JWT-like payload.
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toMatchObject(expected);
}

describe("cli credentials", () => {
  let tempHome: string;
  const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
  function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  }
  function codexRecord(refresh: string, expiry = expSeconds, fields: Record<string, unknown> = {}) {
    return {
      tokens: { access_token: createJwtWithExp(expiry), refresh_token: refresh, ...fields },
    };
  }
  function readCodex(
    options: Parameters<typeof credentials.readCodexCliCredentialsCached>[0] = {},
  ) {
    return credentials.readCodexCliCredentialsCached({
      execSync: execSyncMock,
      ...options,
    });
  }
  beforeAll(async () => {
    credentials = await import("./cli-credentials.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-"));
    vi.stubEnv("CODEX_HOME", tempHome);
    execSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Keychain item not found"), { status: 44 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    execSyncMock.mockReset();
    delete process.env.CODEX_HOME;
    vi.unstubAllEnvs();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM"])(
    "distinguishes missing Codex login state from inspection failure: %s",
    (code) => {
      const failure = Object.assign(new Error(`synthetic ${code}`), { code });
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw failure;
      });
      if (code === "ENOENT" || code === "ENOTDIR") {
        expect(credentials.hasCodexCliAuthFile("/fixture/codex")).toBe(false);
      } else {
        expect(() => credentials.hasCodexCliAuthFile("/fixture/codex")).toThrow(failure);
      }
    },
  );

  it("keeps external CLI credential files anchored to the OS home", () => {
    const osHome = path.join(tempHome, "os");
    const openClawHome = path.join(tempHome, "openclaw");
    const expires = Date.parse("2036-04-25T12:00:00Z");
    const codexExpiry = Math.floor(expires / 1000);
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", openClawHome);
    delete process.env.CODEX_HOME;
    for (const [home, prefix] of [
      [osHome, ""],
      [openClawHome, "decoy-"],
    ] as const) {
      writeJson(
        path.join(home, ".codex", "auth.json"),
        codexRecord(`${prefix}codex-refresh`, codexExpiry),
      );
      for (const provider of ["minimax", "gemini"]) {
        writeJson(path.join(home, `.${provider}`, "oauth_creds.json"), {
          access_token: `${prefix}${provider}-access`,
          refresh_token: `${prefix}${provider}-refresh`,
          expiry_date: expires,
        });
      }
    }
    expectFields(readCodex({ allowKeychainPrompt: false, platform: "linux", ttlMs: 0 }), {
      refresh: "codex-refresh",
      provider: "openai",
    });
    expectFields(credentials.readMiniMaxCliCredentialsCached({ ttlMs: 0 }), {
      access: "minimax-access",
      refresh: "minimax-refresh",
    });
    expectFields(credentials.readGeminiCliCredentialsCached({ ttlMs: 0 }), {
      access: "gemini-access",
      refresh: "gemini-refresh",
    });
  });

  it("falls back when Codex keychain JWT expiry is outside Date range", () => {
    const lastRefresh = Date.parse("2026-01-01T00:00:00Z");
    const fallbackExpiry = lastRefresh + 60 * 60 * 1000;
    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        ...codexRecord("keychain-refresh", 8_700_000_000_000),
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodex({ platform: "darwin" });

    expectFields(creds, {
      refresh: "keychain-refresh",
      provider: "openai",
      expires: fallbackExpiry,
    });
  });

  it.each(["darwin", "linux"] as const)(
    "rejects Codex fallback expiry with invalid source and process clocks on %s",
    (platform) => {
      const record = codexRecord("refresh", 8_700_000_000_000);
      if (platform === "darwin") {
        execSyncMock.mockReturnValue(JSON.stringify(record));
      } else {
        writeJson(path.join(tempHome, "auth.json"), record);
        vi.spyOn(fs, "statSync").mockImplementation(() => {
          throw new Error("stat unavailable");
        });
      }
      vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
      expect(readCodex({ platform })).toBeNull();
    },
  );

  it("falls back to Codex auth.json when keychain is unavailable", () => {
    writeJson(
      path.join(tempHome, "auth.json"),
      codexRecord("file-refresh", expSeconds, {
        id_token: "file-id-token",
      }),
    );
    const creds = readCodex();

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "file-id-token",
    });
  });

  it.each([false, true])(
    "selects only the credential reported active by Codex (API key: %s)",
    (apiKey) => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      const key = "active-file-api-key";
      writeJson(path.join(tempHome, "auth.json"), { auth_mode: "apikey", OPENAI_API_KEY: key });
      const loginStatus = apiKey
        ? "Logged in using an API key - active-f***i-key"
        : "Logged in using ChatGPT";
      execSyncMock.mockImplementation((command: unknown) =>
        !apiKey || String(command).includes("codex login status")
          ? loginStatus
          : JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stale-keychain-api-key" }),
      );
      expect(credentials.readCodexCliActiveApiKey({ codexHome: tempHome })).toEqual(
        apiKey ? { type: "api_key", provider: "openai", key } : null,
      );
      expect(execSyncMock).toHaveBeenCalledTimes(apiKey ? 2 : 1);
    },
  );

  it("treats an empty Codex auth.json API-key field as API-key mode", () => {
    writeJson(path.join(tempHome, "auth.json"), {
      OPENAI_API_KEY: "",
      ...codexRecord("stale-file-refresh"),
    });
    expect(readCodex({ platform: "linux" })).toBeNull();
  });

  it.each([false, true])(
    "isolates Codex prompt-intent caches with file present: %s",
    (withFile) => {
      const fileExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
      const read = (allowKeychainPrompt: boolean) =>
        readCodex({
          ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
          platform: "darwin",
          allowKeychainPrompt,
        });
      if (withFile) {
        writeJson(path.join(tempHome, "auth.json"), codexRecord("file-refresh", fileExpiry));
      } else {
        expect(read(false)).toBeNull();
      }
      execSyncMock.mockReturnValue(JSON.stringify(codexRecord("keychain-refresh")));
      expectFields(read(true), {
        access: createJwtWithExp(expSeconds),
        refresh: "keychain-refresh",
        expires: expSeconds * 1000,
        provider: "openai",
      });
      if (withFile) {
        expectFields(read(false), {
          refresh: "file-refresh",
          expires: fileExpiry * 1000,
          provider: "openai",
        });
      }
      expect(execSyncMock).toHaveBeenCalledTimes(1);
    },
  );

  it("invalidates cached Codex credentials when auth.json changes within the TTL window", () => {
    const authPath = path.join(tempHome, "auth.json");
    const firstExpiry = expSeconds;
    const secondExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    writeJson(authPath, codexRecord("stale-refresh", firstExpiry));
    fs.utimesSync(authPath, new Date("2026-03-24T10:00:00Z"), new Date("2026-03-24T10:00:00Z"));
    vi.setSystemTime(new Date("2026-03-24T10:00:00Z"));

    const first = readCodex({
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "linux",
    });

    expectFields(first, {
      refresh: "stale-refresh",
      expires: firstExpiry * 1000,
    });

    writeJson(authPath, codexRecord("fresh-refresh", secondExpiry));
    fs.utimesSync(authPath, new Date("2026-03-24T10:05:00Z"), new Date("2026-03-24T10:05:00Z"));
    vi.advanceTimersByTime(60_000);

    const second = readCodex({
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "linux",
    });

    expectFields(second, {
      refresh: "fresh-refresh",
      expires: secondExpiry * 1000,
    });
  });

  it("lifts Google account identity from the Gemini id_token", () => {
    const idTokenPayload = Buffer.from(
      JSON.stringify({ sub: "google-account-42", email: "user@example.com" }),
    ).toString("base64url");
    const idToken = `header.${idTokenPayload}.signature`;
    writeJson(path.join(tempHome, ".gemini", "oauth_creds.json"), {
      access_token: "gemini-access",
      refresh_token: "gemini-refresh",
      id_token: idToken,
      expiry_date: Date.parse("2026-04-25T12:00:00Z"),
    });

    const creds = credentials.readGeminiCliCredentialsCached({ homeDir: tempHome, ttlMs: 0 });

    expectFields(creds, {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "gemini-access",
      refresh: "gemini-refresh",
      accountId: "google-account-42",
      email: "user@example.com",
    });
  });

  it("resolves a native login owner only for backends that own one", async () => {
    // A readable Claude login must not leak into other backends' history ownership.
    vi.stubEnv("HOME", tempHome);
    writeJson(path.join(tempHome, ".claude", ".credentials.json"), {
      claudeAiOauth: {
        accessToken: "synthetic",
        expiresAt: Date.parse("2030-01-01T00:00:00Z"),
      },
    });
    const fetchFn = vi.fn(async () => Response.json({ account: { uuid: "uuid-a" } }));
    vi.stubGlobal("fetch", fetchFn);
    for (const backendId of ["google-gemini-cli", "codex-cli"]) {
      expect(await credentials.resolveNativeCliLoginOwner(backendId, process.env)).toEqual({});
      expect(credentials.readAttestedNativeCliLoginOwner(backendId, process.env)).toBeUndefined();
    }
    expect(fetchFn).not.toHaveBeenCalled();
    // The Claude backend attests the same login, and only then answers the local check.
    expect(credentials.readAttestedNativeCliLoginOwner("claude-cli", process.env)).toBeUndefined();
    expect((await credentials.resolveNativeCliLoginOwner("claude-cli", process.env)).owner).toBe(
      "uuid:uuid-a",
    );
    expect(credentials.readAttestedNativeCliLoginOwner("claude-cli", process.env)).toBe(
      "uuid:uuid-a",
    );
  });
});
