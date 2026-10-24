import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const profileMocks = vi.hoisted(() => ({
  managedUserDataDir: "",
  tempRoot: "",
  cookiesSetManyViaPlaywright: vi.fn(async (params: { cookies: unknown[] }) => ({
    added: params.cookies.length,
  })),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => ({ browser: {} }),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: vi.fn(async () => ({
    termination: "exit",
    code: 0,
    stdout: Buffer.from("fixture-value"),
  })),
}));

vi.mock("./chrome.js", () => ({
  resolveOpenClawUserDataDir: () => profileMocks.managedUserDataDir,
}));

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => ({
    cookiesSetManyViaPlaywright: profileMocks.cookiesSetManyViaPlaywright,
  })),
}));

vi.mock("./server-context.js", () => ({
  runProfileContextOperation: async (
    _profile: unknown,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal, runtime: { running: { userDataDir: string } }) => Promise<unknown>,
    options?: { commit?: (result: unknown) => Promise<void> },
  ) => {
    const result = await run(signal ?? new AbortController().signal, {
      running: { userDataDir: profileMocks.managedUserDataDir },
    });
    await options?.commit?.(result);
    return result;
  },
}));

const { listSystemProfiles, readSystemProfileCookies, importSystemProfileCookies } =
  await import("./system-profiles.js");

const KEYCHAIN_FIXTURE = "fixture-value";
const source = { browser: "chrome", systemProfile: "Default" };
const counts = { total: 2, imported: 1, failed: 0, skipped: 1 };
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSystemProfileFixture(): string {
  const homeDir = tempDirs.make("openclaw-system-profile-test-");
  const root = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  const profileDir = path.join(root, "Default", "Network");
  fs.mkdirSync(profileDir, { recursive: true });
  writeLocalState(root, { name: "Personal" });
  const database = new DatabaseSync(path.join(profileDir, "Cookies"));
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
        encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER,
        is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)
    `);
    const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // v10 AES-CBC fixtures include the host SHA-256 prefix and use KEYCHAIN_FIXTURE.
    const session = "djEw8FLknA8Ona/SEEK8MTWrp/+ee1iVrGr3X9Yj7z27UVFg6JceGIrbjRVGGZ+bWFdL";
    const other = "djEwp3ELZgi3xCQ4ldhiSMXq3DesWjG+/zPQvHcoUFFBAQnyJofxh4DlFFHdHo97Urjj";
    for (const [host, name, encrypted] of [
      [".example.com", "session", session],
      [".other.test", "other", other],
    ] as const) {
      insert.run(host, "", name, "", Buffer.from(encrypted, "base64"), "/", 0, 1, 1, 0, -1);
    }
  } finally {
    database.close();
  }
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  return path.join(profileDir, "Cookies");
}

function writeLocalState(root: string, info: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: info } } }),
  );
}

function createManagedProfileFixture() {
  profileMocks.managedUserDataDir = tempDirs.make("openclaw-managed-profile-test-");
  writeLocalState(profileMocks.managedUserDataDir, { openclaw_mock_keychain: true });
  const profile = {
    name: "imported",
    driver: "openclaw" as const,
    cdpUrl: "http://127.0.0.1:18800",
    cdpIsLoopback: true,
    attachOnly: false,
  };
  return {
    ctx: {
      state: () => ({ resolved: { profiles: { imported: profile } } }),
      forProfile: () => ({
        profile,
        ensureBrowserAvailable: vi.fn(async () => {}),
        ensureTabAvailable: vi.fn(async () => ({ targetId: "tab-1" })),
      }),
    },
    createProfile: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  profileMocks.cookiesSetManyViaPlaywright.mockClear();
  profileMocks.tempRoot = tempDirs.make("openclaw-system-cookies-test-");
  vi.stubEnv("XDG_CACHE_HOME", profileMocks.tempRoot);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32")(
  "keeps the event loop running while browser data access is parked",
  async () => {
    const homeDir = tempDirs.make("openclaw-system-profile-parked-");
    const root = path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
    fs.mkdirSync(root, { recursive: true });
    // A FIFO parks open() until a writer arrives, like macOS App Data consent awaiting an answer.
    const localState = path.join(root, "Local State");
    execFileSync("mkfifo", [localState]);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    // Releases a synchronous reader so a regression fails the assertion instead of hanging.
    const valve = spawn(
      "sh",
      ["-c", 'sleep 3; while :; do printf "{}" > "$1"; done', "sh", localState],
      { stdio: "ignore" },
    );
    const readFile = vi.spyOn(fs.promises, "readFile");
    try {
      let settled = false;
      const discoveries = Promise.all([listSystemProfiles("chrome"), listSystemProfiles()]).finally(
        () => {
          settled = true;
        },
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).toBe(false);

      await fs.promises.writeFile(
        localState,
        JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }),
      );
      const personal = [{ browser: "chrome", id: "Default", name: "Personal", hasCookies: false }];
      await expect(discoveries).resolves.toEqual([personal, personal]);
      expect(readFile.mock.calls.filter(([file]) => file === localState)).toHaveLength(1);
    } finally {
      valve.kill();
    }
  },
);

it("snapshots, decrypts, and applies the domain allowlist", async () => {
  createSystemProfileFixture();
  const readSecret = vi.fn(async () => Buffer.from(KEYCHAIN_FIXTURE));

  const result = await readSystemProfileCookies(
    { ...source, domains: ["example.com"] },
    { readSecret },
  );

  expect(result).toMatchObject({
    browser: "chrome",
    systemProfile: "Default",
    counts,
    domains: [".example.com"],
    cookies: [{ name: "session", value: "allowed-value", domain: ".example.com" }],
  });
  expect(readSecret).toHaveBeenCalledOnce();
  expect(fs.readdirSync(path.join(profileMocks.tempRoot, "openclaw"))).toEqual([]);
});

it("reads committed WAL cookies without synchronous snapshot writes on the request thread", async () => {
  const cookiesFile = createSystemProfileFixture();
  const writer = new DatabaseSync(cookiesFile);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer
      .prepare("UPDATE cookies SET value = ?, encrypted_value = ? WHERE name = ?")
      .run("fresh-wal-value", Buffer.alloc(0), "session");
    expect(fs.statSync(`${cookiesFile}-wal`).size).toBeGreaterThan(0);
    const syncFlush = vi.spyOn(fs, "fsyncSync");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    const result = await readSystemProfileCookies(
      { ...source, domains: ["example.com"] },
      { readSecret: async () => Buffer.from(KEYCHAIN_FIXTURE) },
    );

    expect(result.cookies).toEqual([
      expect.objectContaining({ name: "session", value: "fresh-wal-value" }),
    ]);
    expect(syncFlush).not.toHaveBeenCalled();
    expect(prepare.mock.calls.some(([sql]) => /\b(?:VACUUM|COMMIT)\b/i.test(sql))).toBe(false);
    expect(fs.readdirSync(path.join(profileMocks.tempRoot, "openclaw"))).toEqual([]);
  } finally {
    writer.close();
  }
});

it("removes cookie snapshot scratch when reading invalid SQLite bytes fails", async () => {
  const cookiesFile = createSystemProfileFixture();
  fs.writeFileSync(cookiesFile, "not a SQLite database");

  await expect(readSystemProfileCookies(source)).rejects.toThrow(/not a database/);
  expect(fs.readdirSync(path.join(profileMocks.tempRoot, "openclaw"))).toEqual([]);
});

it("keeps the existing import flow on the shared reader", async () => {
  createSystemProfileFixture();
  const runtime = createManagedProfileFixture();

  const result = await importSystemProfileCookies(
    { ...source, into: "imported", domains: ["example.com"] },
    runtime as never,
  );

  expect(result.cookies).toEqual(counts);
  expect(profileMocks.cookiesSetManyViaPlaywright).toHaveBeenCalledWith(
    expect.objectContaining({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      cookies: [expect.objectContaining({ domain: ".example.com", name: "session" })],
    }),
  );
});
