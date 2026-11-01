import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureExtensionRelayToken, readExtensionRelayToken } from "./relay-auth.js";

let stateDir = "";
let secretPath = "";
let credentials = "";
let env: NodeJS.ProcessEnv;
const ensureToken = () => ensureExtensionRelayToken(env);
const readToken = () => readExtensionRelayToken(env);

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-auth-")));
  credentials = path.join(stateDir, "credentials");
  secretPath = path.join(credentials, "browser-extension-relay.secret");
  env = { OPENCLAW_STATE_DIR: stateDir };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("reuses a valid key without mutating its symlinked directory", async () => {
  const first = await ensureToken();
  if (process.platform !== "win32") {
    fs.chmodSync(credentials, 0o750);
  }
  const target = path.join(stateDir, "credential-target");
  fs.renameSync(credentials, target);
  fs.symlinkSync(target, credentials, "junction");
  const { dev, ino, mode } = fs.statSync(secretPath);
  const bytes = fs.readFileSync(secretPath);
  await expect(ensureToken()).resolves.toBe(first);
  expect(readToken()).toBe(first);
  expect(fs.readFileSync(secretPath)).toEqual(bytes);
  expect(fs.statSync(secretPath)).toMatchObject({ dev, ino, mode });
  expect(fs.lstatSync(credentials).isSymbolicLink()).toBe(true);
  if (process.platform !== "win32") {
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o750);
  }
});

it.each([
  { name: "simultaneous first callers", writerStarted: false, symlink: false },
  { name: "a writer in progress through a directory alias", writerStarted: true, symlink: true },
])("adopts the first writer's token with $name", async ({ writerStarted, symlink }) => {
  const writerToken = "a1".repeat(32);
  const target = symlink ? path.join(stateDir, "credential-target") : credentials;
  fs.mkdirSync(target, { mode: 0o700 });
  if (symlink) {
    fs.symlinkSync(target, credentials, "junction");
  }
  const fd = writerStarted
    ? fs.openSync(path.join(target, path.basename(secretPath)), "wx", 0o600)
    : undefined;
  try {
    const before = fd === undefined ? undefined : fs.fstatSync(fd);
    const tokens = Promise.all([ensureToken(), ensureToken()]);
    // Hold the first writer's empty file until both callers have started.
    if (fd !== undefined) {
      fs.writeFileSync(fd, `${writerToken}\n`);
    }
    const [first, second] = await tokens;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(readToken()).toBe(first);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.lstatSync(credentials).isSymbolicLink()).toBe(symlink);
    if (before) {
      expect(first).toBe(writerToken);
      expect(fs.readFileSync(secretPath, "utf8")).toBe(`${writerToken}\n`);
      expect(fs.statSync(secretPath)).toMatchObject({ dev: before.dev, ino: before.ino });
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
});

it("rejects creating a missing key through a symlinked credential directory", async () => {
  const target = path.join(stateDir, "credential-target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, credentials, "junction");
  await expect(ensureToken()).rejects.toThrow("must not be a symlink");
  expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.lstatSync(credentials).isSymbolicLink()).toBe(true);
});

it.each([
  ["empty", "", "is empty"],
  ["malformed", "not-a-relay-token\n", "does not contain a 64-character lowercase hex token"],
  ["uppercase", `${"A".repeat(64)}\n`, "does not contain a 64-character lowercase hex token"],
])("rejects a persistent %s secret without replacing it", async (_name, content, problem) => {
  fs.mkdirSync(credentials, { mode: 0o700 });
  fs.writeFileSync(secretPath, content, { flag: "wx", mode: 0o600 });
  const { dev, ino } = fs.statSync(secretPath);
  await expect(ensureToken()).rejects.toThrow(
    `Browser extension relay secret ${secretPath} ${problem}. Move it aside, then run`,
  );
  expect(fs.readFileSync(secretPath, "utf8")).toBe(content);
  expect(fs.statSync(secretPath)).toMatchObject({ dev, ino });
});

describe.runIf(process.platform !== "win32")("rejected secret files", () => {
  it.each([
    [
      "a symlink",
      "is a symlink",
      () => {
        const target = path.join(stateDir, "elsewhere.secret");
        fs.writeFileSync(target, `${"a".repeat(64)}\n`, { mode: 0o600 });
        fs.symlinkSync(target, secretPath);
      },
    ],
    ["a directory", "is not a regular file", () => fs.mkdirSync(secretPath)],
    [
      "hard-linked",
      "has 2 hard links",
      () => {
        fs.writeFileSync(secretPath, `${"a".repeat(64)}\n`, { mode: 0o600 });
        fs.linkSync(secretPath, path.join(stateDir, "backup.secret"));
      },
    ],
  ])("fails without waiting or replacing when the secret is %s", async (_name, problem, setup) => {
    fs.mkdirSync(credentials, { mode: 0o700 });
    setup();
    const before = fs.lstatSync(secretPath);
    // A retry loop would stall on fake timers; persistent states must fail on the first read.
    vi.useFakeTimers();
    try {
      const error = await ensureToken().catch((err: unknown) => err);
      expect(String(error)).toContain(`${secretPath} ${problem}.`);
      expect(String(error)).toContain("browser extension pair");
    } finally {
      vi.useRealTimers();
    }
    expect(fs.lstatSync(secretPath)).toMatchObject({ dev: before.dev, ino: before.ino });
  });
});

describe.runIf(process.platform !== "win32")("POSIX secret protection", () => {
  it.each([true, false])(
    "repairs broad permissions only when chmod succeeds (%s)",
    async (allowed) => {
      const token = await ensureToken();
      fs.chmodSync(secretPath, 0o644);
      if (!allowed) {
        vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
          throw new Error("permission denied");
        });
      }
      expect(readToken()).toBe(allowed ? token : null);
      expect(fs.statSync(secretPath).mode & 0o777).toBe(allowed ? 0o600 : 0o644);
    },
  );

  it("refuses a foreign-owned secret without changing it", async () => {
    const token = await ensureToken();
    const owner = fs.statSync(secretPath).uid;
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    expect(readToken()).toBeNull();
    await expect(ensureToken()).rejects.toThrow(`is owned by another user (uid ${owner})`);
    expect(fs.readFileSync(secretPath, "utf8").trim()).toBe(token);
  });

  it("rejects a swapped key path without changing its replacement", async () => {
    await ensureToken();
    fs.chmodSync(secretPath, 0o644);
    const replacement = path.join(stateDir, "replacement");
    fs.writeFileSync(replacement, "b2".repeat(32), { mode: 0o644 });
    // Creation modes are masked by umask; the replacement must start broad.
    fs.chmodSync(replacement, 0o644);
    const inspected = fs.lstatSync(secretPath);
    vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
      fs.renameSync(secretPath, path.join(stateDir, "original"));
      fs.symlinkSync(replacement, secretPath);
      return inspected;
    });

    expect.soft(readToken()).toBeNull();
    expect(fs.statSync(replacement).mode & 0o777).toBe(0o644);
  });
});

it("refuses a symlinked secret", async () => {
  const token = await ensureToken();
  const realTarget = path.join(stateDir, "elsewhere.secret");
  fs.renameSync(secretPath, realTarget);
  fs.symlinkSync(realTarget, secretPath);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(readToken()).toBeNull();
});
