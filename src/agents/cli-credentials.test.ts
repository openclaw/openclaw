/** Tests CLI credential parsing and cache expiry. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execSyncMock = vi.fn();
const CLI_CREDENTIALS_CACHE_TTL_MS = 15 * 60 * 1000;
let readCodexCliActiveApiKey: typeof import("./cli-credentials.js").readCodexCliActiveApiKey;
let readCodexCliCredentialsCached: typeof import("./cli-credentials.js").readCodexCliCredentialsCached;
let readGeminiCliCredentialsCached: typeof import("./cli-credentials.js").readGeminiCliCredentialsCached;
let readMiniMaxCliCredentialsCached: typeof import("./cli-credentials.js").readMiniMaxCliCredentialsCached;

function createJwtWithExp(expSeconds: number): string {
  // Signature verification is out of scope; expiration extraction only needs a
  // syntactically valid JWT-like payload.
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.signature`;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  // Keeps large credential objects readable while still asserting exact fields
  // relevant to the branch under test.
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("cli credentials", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    ({
      readCodexCliActiveApiKey,
      readCodexCliCredentialsCached,
      readGeminiCliCredentialsCached,
      readMiniMaxCliCredentialsCached,
    } = await import("./cli-credentials.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    execSyncMock.mockClear().mockImplementation(() => undefined);
    delete process.env.CODEX_HOME;
    vi.unstubAllEnvs();
  });

  it("keeps external CLI credential files anchored to the OS home", () => {
    const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-os-home-"));
    const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-home-"));
    const expires = Date.parse("2036-04-25T12:00:00Z");
    const codexExpiry = Math.floor(expires / 1000);
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", openClawHome);
    delete process.env.CODEX_HOME;
    try {
      const files = [
        {
          filePath: path.join(osHome, ".codex", "auth.json"),
          value: {
            tokens: {
              access_token: createJwtWithExp(codexExpiry),
              refresh_token: "codex-refresh",
            },
          },
        },
        {
          filePath: path.join(osHome, ".minimax", "oauth_creds.json"),
          value: {
            access_token: "minimax-access",
            refresh_token: "minimax-refresh",
            expiry_date: expires,
          },
        },
        {
          filePath: path.join(osHome, ".gemini", "oauth_creds.json"),
          value: {
            access_token: "gemini-access",
            refresh_token: "gemini-refresh",
            expiry_date: expires,
          },
        },
      ];
      for (const file of files) {
        fs.mkdirSync(path.dirname(file.filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file.filePath, JSON.stringify(file.value), "utf8");
      }
      const decoys = [
        {
          filePath: path.join(openClawHome, ".codex", "auth.json"),
          value: {
            tokens: {
              access_token: createJwtWithExp(codexExpiry),
              refresh_token: "decoy-codex-refresh",
            },
          },
        },
        {
          filePath: path.join(openClawHome, ".minimax", "oauth_creds.json"),
          value: {
            access_token: "decoy-minimax-access",
            refresh_token: "decoy-minimax-refresh",
            expiry_date: expires,
          },
        },
        {
          filePath: path.join(openClawHome, ".gemini", "oauth_creds.json"),
          value: {
            access_token: "decoy-gemini-access",
            refresh_token: "decoy-gemini-refresh",
            expiry_date: expires,
          },
        },
      ];
      for (const file of decoys) {
        fs.mkdirSync(path.dirname(file.filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file.filePath, JSON.stringify(file.value), "utf8");
      }

      expectFields(
        readCodexCliCredentialsCached({
          allowKeychainPrompt: false,
          platform: "linux",
          ttlMs: 0,
        }),
        { refresh: "codex-refresh", provider: "openai" },
      );
      expectFields(readMiniMaxCliCredentialsCached({ ttlMs: 0 }), {
        access: "minimax-access",
        refresh: "minimax-refresh",
      });
      expectFields(readGeminiCliCredentialsCached({ ttlMs: 0 }), {
        access: "gemini-access",
        refresh: "gemini-refresh",
      });
    } finally {
      fs.rmSync(osHome, { recursive: true, force: true });
      fs.rmSync(openClawHome, { recursive: true, force: true });
    }
  });

  it("reads Codex credentials from keychain when available", () => {
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
          id_token: "keychain-id-token",
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentialsCached({ platform: "darwin", execSync: execSyncMock });

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "keychain-id-token",
    });
  });

  it("falls back when Codex keychain JWT expiry is outside Date range", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const lastRefresh = Date.parse("2026-01-01T00:00:00Z");
    const fallbackExpiry = lastRefresh + 60 * 60 * 1000;
    const accountHash = "cli|";

    execSyncMock.mockImplementation((command: unknown) => {
      const cmd = String(command);
      expect(cmd).toContain("Codex Auth");
      expect(cmd).toContain(accountHash);
      return JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "keychain-refresh",
        },
        last_refresh: "2026-01-01T00:00:00Z",
      });
    });

    const creds = readCodexCliCredentialsCached({ platform: "darwin", execSync: execSyncMock });

    expectFields(creds, {
      refresh: "keychain-refresh",
      provider: "openai",
      expires: fallbackExpiry,
    });
  });

  it("rejects Codex keychain fallback expiry when the process clock is invalid", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-"));
    process.env.CODEX_HOME = tempHome;
    const accountHash = "cli|";
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      execSyncMock.mockImplementation((command: unknown) => {
        const cmd = String(command);
        expect(cmd).toContain("Codex Auth");
        expect(cmd).toContain(accountHash);
        return JSON.stringify({
          tokens: {
            access_token: createJwtWithExp(8_700_000_000_000),
            refresh_token: "keychain-refresh",
          },
        });
      });

      expect(
        readCodexCliCredentialsCached({ platform: "darwin", execSync: execSyncMock }),
      ).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("falls back to Codex auth.json when keychain is unavailable", () => {
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
          id_token: "file-id-token",
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );

    const creds = readCodexCliCredentialsCached({ execSync: execSyncMock });

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
      expires: expSeconds * 1000,
      idToken: "file-id-token",
    });
  });

  it("does not read stale Codex tokens when auth.json resolves to API-key mode", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-api-key-mode-"));
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
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-codex-api-key",
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "stale-file-refresh",
        },
      }),
      "utf8",
    );

    expect(readCodexCliCredentialsCached({ platform: "linux", execSync: execSyncMock })).toBeNull();
  });

  it("reads API-key auth from the active Codex Keychain store", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-keychain-api-key-"));
    execSyncMock.mockImplementation((command: unknown) =>
      String(command).includes("codex login status")
        ? "Logged in using an API key - keychain***i-key"
        : JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "keychain-api-key" }),
    );

    expect(
      readCodexCliActiveApiKey({
        codexHome: tempHome,
        platform: "darwin",
        execSync: execSyncMock,
      }),
    ).toEqual({
      status: "active",
      credential: { type: "api_key", provider: "openai", key: "keychain-api-key" },
    });
  });

  it("prefers active Codex OAuth over a stale file API key", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-keychain-oauth-"));
    fs.writeFileSync(
      path.join(tempHome, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stale-file-api-key" }),
      "utf8",
    );
    execSyncMock.mockReturnValue("Logged in using ChatGPT");

    expect(
      readCodexCliActiveApiKey({
        codexHome: tempHome,
        platform: "darwin",
        execSync: execSyncMock,
      }),
    ).toEqual({ status: "none" });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("uses the API key that Codex reports active instead of a stale Keychain record", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-default-file-"));
    fs.writeFileSync(
      path.join(tempHome, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "active-file-api-key" }),
      "utf8",
    );
    execSyncMock.mockImplementation((command: unknown) =>
      String(command).includes("codex login status")
        ? "Logged in using an API key - active-f***i-key"
        : JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stale-keychain-api-key" }),
    );

    expect(
      readCodexCliActiveApiKey({
        codexHome: tempHome,
        platform: "darwin",
        execSync: execSyncMock,
      }),
    ).toEqual({
      status: "active",
      credential: { type: "api_key", provider: "openai", key: "active-file-api-key" },
    });
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("accepts legacy Codex API-key status only with one readable candidate", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-legacy-status-"));
    fs.writeFileSync(
      path.join(tempHome, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "legacy-file-api-key" }),
      "utf8",
    );
    execSyncMock.mockReturnValue("Logged in using an API key");

    expect(
      readCodexCliActiveApiKey({
        codexHome: tempHome,
        platform: "linux",
        execSync: execSyncMock,
      }),
    ).toEqual({
      status: "active",
      credential: { type: "api_key", provider: "openai", key: "legacy-file-api-key" },
    });
  });

  it.each([
    {
      name: "a confirmed logout",
      installed: true,
      failure: { status: 1, stdout: "WARNING: fixture notice\nNot logged in\n" },
      expected: { status: "none" },
    },
    {
      // cmd.exe exits 1 with a localized message, so only the PATH lookup identifies this.
      name: "a missing codex command",
      installed: false,
      failure: { status: 1, stdout: "fixture shell: codex is not a command\n" },
      expected: { status: "none" },
    },
    {
      name: "a failed Codex login check",
      installed: true,
      failure: {
        status: 1,
        stdout: 'Error checking login status: invalid value "sk-leaked-secret"\n',
      },
      expected: { status: "unreadable", reason: "Codex could not check its login status" },
    },
    {
      name: "a timed-out login check",
      installed: true,
      failure: { code: "ETIMEDOUT", status: null, stdout: "" },
      expected: { status: "unreadable", reason: "`codex login status` timed out" },
    },
    {
      name: "a failed login check after the working directory is removed",
      installed: true,
      cwdRemoved: true,
      failure: { status: 1, stdout: "Error checking login status: fixture failure\n" },
      expected: { status: "unreadable", reason: "Codex could not check its login status" },
    },
  ])(
    "separates $name from an unreadable Codex login",
    ({ installed, cwdRemoved, failure, expected }) => {
      const tempHome = tempDirs.make("openclaw-codex-status-failure-");
      const binDir = tempDirs.make("openclaw-codex-bin-");
      if (installed) {
        for (const name of ["codex", "codex.cmd"]) {
          fs.writeFileSync(path.join(binDir, name), "", { mode: 0o755 });
        }
      }
      vi.stubEnv("PATH", binDir);
      execSyncMock.mockImplementation(() => {
        throw Object.assign(new Error("Command failed: codex login status"), failure);
      });
      // Node's process.cwd() throws once a long-running Gateway's launch directory is deleted.
      const cwdSpy = cwdRemoved
        ? vi.spyOn(process, "cwd").mockImplementation(() => {
            throw Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" });
          })
        : undefined;

      try {
        expect(
          readCodexCliActiveApiKey({
            codexHome: tempHome,
            platform: "linux",
            execSync: execSyncMock,
          }),
        ).toEqual(expected);
      } finally {
        cwdSpy?.mockRestore();
      }
    },
  );

  // Only Codex's `auto` store falls back to an empty auth.json after a failed Keychain read,
  // so "Not logged in" alone cannot prove a logout there. In the default `file` store the
  // Keychain is irrelevant and its failures must not override a real logout. The effective
  // store comes from `codex doctor` (it sees managed policy); config.toml is the fallback
  // for Codex builds without it.
  const DENIED = {
    status: "unreadable",
    reason: "the macOS Keychain did not return the Codex login (`security` exited with code 51)",
  };
  const AUTO_CONFIG = 'cli_auth_credentials_store = "auto"\n';
  it.each([
    {
      name: "doctor reports auto (managed, no config.toml) + denied Keychain read is unreadable",
      doctor: "Auto",
      securityFailure: { status: 51 },
      expected: DENIED,
      doctorCalls: 1,
    },
    {
      name: "doctor reports auto, exiting 1 with its report on stdout, is honored",
      doctor: "Auto",
      doctorExits: true,
      securityFailure: { status: 51 },
      expected: DENIED,
      doctorCalls: 1,
    },
    {
      name: "doctor reports file, overriding an auto config.toml, ignores a denied Keychain read",
      doctor: "File",
      config: AUTO_CONFIG,
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 1,
    },
    {
      name: "doctor unavailable falls back to an auto config.toml",
      config: AUTO_CONFIG,
      securityFailure: { status: 51 },
      expected: DENIED,
      doctorCalls: 1,
    },
    {
      name: "doctor unavailable falls back to a top-level auto after other keys and comments",
      config: '# my codex\nmodel = "gpt"\ncli_auth_credentials_store = "auto"  # keychain\n',
      securityFailure: { status: 51 },
      expected: DENIED,
      doctorCalls: 1,
    },
    {
      name: "doctor unavailable + explicit file config.toml ignores a denied Keychain read",
      config: 'cli_auth_credentials_store = "file"\n',
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 1,
    },
    {
      name: "doctor unavailable + no Codex config (default file) ignores a denied Keychain read",
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 1,
    },
    {
      name: "doctor unavailable + an auto setting scoped to a config table does not apply",
      config: 'model = "gpt"\n\n[profiles.work]\ncli_auth_credentials_store = "auto"\n',
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 1,
    },
    {
      name: "a missing Keychain item is a real logout without asking doctor",
      doctor: "Auto",
      securityFailure: { status: 44 },
      expected: { status: "none" },
      doctorCalls: 0,
    },
    {
      name: "prompts disabled never probes the Keychain or asks doctor",
      doctor: "Auto",
      allowKeychainPrompt: false,
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 0,
    },
    {
      name: "a non-macOS platform never probes the Keychain or asks doctor",
      doctor: "Auto",
      platform: "linux" as const,
      securityFailure: { status: 51 },
      expected: { status: "none" },
      doctorCalls: 0,
    },
  ])("after Codex reports Not logged in, $name", (testCase) => {
    const tempHome = tempDirs.make("openclaw-codex-not-logged-in-");
    const binDir = tempDirs.make("openclaw-codex-bin-");
    if (testCase.config !== undefined) {
      fs.writeFileSync(path.join(tempHome, "config.toml"), testCase.config, "utf8");
    }
    for (const name of ["codex", "codex.cmd"]) {
      fs.writeFileSync(path.join(binDir, name), "", { mode: 0o755 });
    }
    vi.stubEnv("PATH", binDir);
    const doctorReport = JSON.stringify({
      schemaVersion: 1,
      checks: { "auth.credentials": { details: { "auth storage mode": testCase.doctor } } },
    });
    execSyncMock.mockImplementation((command: unknown) => {
      if (String(command).includes("codex login status")) {
        throw Object.assign(new Error("Command failed: codex login status"), {
          status: 1,
          stdout: "Not logged in\n",
        });
      }
      if (String(command).includes("codex doctor")) {
        if (testCase.doctor === undefined) {
          throw Object.assign(new Error("Command failed: codex doctor"), {
            status: 2,
            stdout: "",
          });
        }
        if (testCase.doctorExits) {
          throw Object.assign(new Error("Command failed: codex doctor"), {
            status: 1,
            stdout: doctorReport,
          });
        }
        return doctorReport;
      }
      throw Object.assign(new Error("Command failed: security"), testCase.securityFailure);
    });

    expect(
      readCodexCliActiveApiKey({
        codexHome: tempHome,
        platform: testCase.platform ?? "darwin",
        execSync: execSyncMock,
        ...(testCase.allowKeychainPrompt === undefined
          ? {}
          : { allowKeychainPrompt: testCase.allowKeychainPrompt }),
      }),
    ).toEqual(testCase.expected);
    expect(
      execSyncMock.mock.calls.filter(([command]) => String(command).includes("codex doctor")),
    ).toHaveLength(testCase.doctorCalls);
  });

  it.each([
    {
      name: "falls back to auth.json",
      fileKey: "active-file-api-key",
      expected: {
        status: "active",
        credential: { type: "api_key", provider: "openai", key: "active-file-api-key" },
      },
    },
    {
      name: "reports the Keychain failure without auth.json",
      fileKey: undefined,
      expected: {
        status: "unreadable",
        reason:
          "the macOS Keychain did not return the Codex login (`security` exited with code 51)",
      },
    },
  ])("when the Codex Keychain read is denied, $name", ({ fileKey, expected }) => {
    const tempHome = tempDirs.make("openclaw-codex-keychain-denied-");
    if (fileKey) {
      fs.writeFileSync(
        path.join(tempHome, "auth.json"),
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: fileKey }),
        "utf8",
      );
    }
    execSyncMock.mockImplementation((command: unknown) => {
      if (String(command).includes("codex login status")) {
        return "Logged in using an API key - active-f***i-key";
      }
      throw Object.assign(new Error("Command failed: security"), { status: 51 });
    });

    expect(
      readCodexCliActiveApiKey({ codexHome: tempHome, platform: "darwin", execSync: execSyncMock }),
    ).toEqual(expected);
  });

  it("treats an empty Codex auth.json API-key field as API-key mode", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-empty-api-key-mode-"));
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
        OPENAI_API_KEY: "",
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "stale-file-refresh",
        },
      }),
      "utf8",
    );

    expect(readCodexCliCredentialsCached({ platform: "linux", execSync: execSyncMock })).toBeNull();
  });

  it("rejects Codex auth.json fallback expiry when stat and process clock are invalid", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-invalid-clock-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const statSyncSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("stat unavailable");
    });
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(
        readCodexCliCredentialsCached({ platform: "linux", execSync: execSyncMock }),
      ).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
      statSyncSpy.mockRestore();
    }
  });

  it("uses Codex auth.json fallback expiry when file mtime has fractional milliseconds", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-fractional-mtime-"));
    process.env.CODEX_HOME = tempHome;
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(8_700_000_000_000),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const mtimeMs = Date.parse("2026-03-24T10:00:00Z") + 0.75;
    const statSyncSpy = vi.spyOn(fs, "statSync").mockReturnValue({ mtimeMs } as fs.Stats);
    try {
      const creds = readCodexCliCredentialsCached({ platform: "linux", execSync: execSyncMock });

      expectFields(creds, {
        refresh: "file-refresh",
        provider: "openai",
        expires: Math.floor(mtimeMs) + 60 * 60 * 1000,
      });
    } finally {
      statSyncSpy.mockRestore();
    }
  });

  it("does not read Codex keychain when keychain prompts are disabled", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-no-prompt-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
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

    const creds = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(creds, {
      access: createJwtWithExp(expSeconds),
      refresh: "file-refresh",
      provider: "openai",
    });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("does not let no-keychain Codex cache misses poison keychain reads", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const expSeconds = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);

    const withoutKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });
    expect(withoutKeychain).toBeNull();

    execSyncMock.mockReturnValue(
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(expSeconds),
          refresh_token: "keychain-refresh",
        },
      }),
    );
    const withKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      access: createJwtWithExp(expSeconds),
      refresh: "keychain-refresh",
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps no-prompt Codex reads on auth.json after a keychain read", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-cache-"));
    process.env.CODEX_HOME = tempHome;
    const keychainExpiry = Math.floor(Date.parse("2026-03-24T12:34:56Z") / 1000);
    const fileExpiry = Math.floor(Date.parse("2026-03-25T12:34:56Z") / 1000);
    const authPath = path.join(tempHome, "auth.json");
    fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(fileExpiry),
          refresh_token: "file-refresh",
        },
      }),
      "utf8",
    );
    execSyncMock.mockReturnValue(
      JSON.stringify({
        tokens: {
          access_token: createJwtWithExp(keychainExpiry),
          refresh_token: "keychain-refresh",
        },
      }),
    );

    const withKeychain = readCodexCliCredentialsCached({
      allowKeychainPrompt: true,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });
    const withoutPrompt = readCodexCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLI_CREDENTIALS_CACHE_TTL_MS,
      platform: "darwin",
      execSync: execSyncMock,
    });

    expectFields(withKeychain, {
      refresh: "keychain-refresh",
      expires: keychainExpiry * 1000,
      provider: "openai",
    });
    expectFields(withoutPrompt, {
      refresh: "file-refresh",
      expires: fileExpiry * 1000,
      provider: "openai",
    });
    expect(execSyncMock).toHaveBeenCalledTimes(1);
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

      expectFields(first, {
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

      expectFields(second, {
        refresh: "fresh-refresh",
        expires: secondExpiry * 1000,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("lifts Google account identity from the Gemini id_token", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gemini-"));
    try {
      const credPath = path.join(tempHome, ".gemini", "oauth_creds.json");
      fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
      const idTokenPayload = Buffer.from(
        JSON.stringify({ sub: "google-account-42", email: "user@example.com" }),
      ).toString("base64url");
      const idToken = `header.${idTokenPayload}.signature`;
      fs.writeFileSync(
        credPath,
        JSON.stringify({
          access_token: "gemini-access",
          refresh_token: "gemini-refresh",
          id_token: idToken,
          expiry_date: Date.parse("2026-04-25T12:00:00Z"),
        }),
        "utf8",
      );

      const creds = readGeminiCliCredentialsCached({ homeDir: tempHome, ttlMs: 0 });

      expectFields(creds, {
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh: "gemini-refresh",
        accountId: "google-account-42",
        email: "user@example.com",
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("reads Gemini credentials without identity fields when id_token is absent", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gemini-noid-"));
    try {
      const credPath = path.join(tempHome, ".gemini", "oauth_creds.json");
      fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        credPath,
        JSON.stringify({
          access_token: "gemini-access",
          refresh_token: "gemini-refresh",
          expiry_date: Date.parse("2026-04-25T12:00:00Z"),
        }),
        "utf8",
      );

      const creds = readGeminiCliCredentialsCached({ homeDir: tempHome, ttlMs: 0 });

      expectFields(creds, {
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh: "gemini-refresh",
      });
      expect(creds?.accountId).toBeUndefined();
      expect(creds?.email).toBeUndefined();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
