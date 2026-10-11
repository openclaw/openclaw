import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const browserUtilsMock = vi.hoisted(() => ({ configDir: "/tmp/openclaw-state" }));
const realMkdirSync = fs.mkdirSync.bind(fs);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
const realRmSync = fs.rmSync.bind(fs);
const realWriteFileSync = fs.writeFileSync.bind(fs);
const realRealpathSyncNative = fs.realpathSync.native.bind(fs.realpathSync);

vi.mock("openclaw/plugin-sdk/text-utility-runtime", () => ({
  get CONFIG_DIR() {
    return browserUtilsMock.configDir;
  },
}));

let movePathToTrash: typeof import("./trash.js").movePathToTrash;

beforeAll(async () => {
  vi.resetModules();
  ({ movePathToTrash } = await import("./trash.js"));
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/text-utility-runtime");
  vi.resetModules();
});

describe("browser trash", () => {
  let testRoot = "";
  let configDir = "";
  let homeDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    testRoot = realRealpathSyncNative(realMkdtempSync(path.join(os.tmpdir(), "openclaw-browser-")));
    configDir = path.join(testRoot, "state");
    homeDir = path.join(testRoot, "home", "test");
    browserUtilsMock.configDir = configDir;
    realMkdirSync(configDir, { recursive: true, mode: 0o700 });
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) =>
      realRealpathSyncNative(candidate),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) {
      realRmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("allows managed browser data under a configured state directory outside home", async () => {
    const target = path.join(configDir, "browser", "constructor");
    realMkdirSync(target, { recursive: true });
    realWriteFileSync(path.join(target, "Preferences"), "profile data");

    const moved = await movePathToTrash(target);
    const trashDir = path.join(homeDir, ".Trash");
    const reservation = path.dirname(moved);
    expect(moved.startsWith(`${trashDir}${path.sep}`)).toBe(true);
    expect(reservation).not.toBe(trashDir);
    expect(path.basename(moved)).toBe("constructor");
    expect(fs.realpathSync.native(moved)).toBe(moved);
    const reservationStat = fs.lstatSync(reservation);
    expect(reservationStat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(reservationStat.mode & 0o777).toBe(0o700);
    }
    expect(fs.readFileSync(path.join(moved, "Preferences"), "utf8")).toBe("profile data");
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("does not authorize other configured-state paths", async () => {
    const target = path.join(configDir, "credentials", "token.json");
    realMkdirSync(path.dirname(target), { recursive: true });
    realWriteFileSync(target, "secret");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("does not grant arbitrary filesystem authority for a root config directory", async () => {
    browserUtilsMock.configDir = path.parse(testRoot).root;
    const target = path.join(testRoot, "outside-root-browser");
    realWriteFileSync(target, "outside");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("trashes an in-root symlink entry without moving its outside profile", async () => {
    const browserDir = path.join(configDir, "browser");
    const outsideDir = path.join(testRoot, "outside-profile");
    realMkdirSync(browserDir, { recursive: true });
    realMkdirSync(outsideDir, { recursive: true });
    realWriteFileSync(path.join(outsideDir, "Preferences"), "outside profile");
    const target = path.join(browserDir, "constructor");
    fs.symlinkSync(outsideDir, target, "dir");

    const moved = await movePathToTrash(target);

    expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(moved)).toBe(outsideDir);
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.lstatSync(outsideDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(outsideDir)).toEqual(["Preferences"]);
    expect(fs.readFileSync(path.join(outsideDir, "Preferences"), "utf8")).toBe("outside profile");
    const trashDir = path.join(homeDir, ".Trash");
    const reservation = path.dirname(moved);
    expect(path.dirname(reservation)).toBe(trashDir);
    expect(fs.readdirSync(trashDir)).toEqual([path.basename(reservation)]);
    expect(fs.readdirSync(reservation)).toEqual([path.basename(target)]);
  });

  it("rejects entries whose symlinked parent resolves outside the Browser root", async () => {
    const browserDir = path.join(configDir, "browser");
    const outsideDir = path.join(testRoot, "outside-profile");
    const outsideTarget = path.join(outsideDir, "nested", "profile");
    realMkdirSync(browserDir, { recursive: true });
    realMkdirSync(outsideTarget, { recursive: true });
    realWriteFileSync(path.join(outsideTarget, "Preferences"), "outside profile");
    const parentAlias = path.join(browserDir, "escaped-parent");
    fs.symlinkSync(outsideDir, parentAlias, "dir");
    const target = path.join(parentAlias, "nested", "profile");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
    expect(fs.readlinkSync(parentAlias)).toBe(outsideDir);
    expect(fs.lstatSync(outsideTarget).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(outsideTarget, "Preferences"), "utf8")).toBe(
      "outside profile",
    );
    expect(fs.readdirSync(path.join(homeDir, ".Trash"))).toEqual([]);
  });

  it("trashes an in-root symlink entry without moving its profile data", async () => {
    const browserDir = path.join(configDir, "browser");
    const profileDir = path.join(browserDir, "profile");
    realMkdirSync(profileDir, { recursive: true });
    realWriteFileSync(path.join(profileDir, "Preferences"), "profile data");
    const target = path.join(browserDir, "alias");
    fs.symlinkSync(profileDir, target, "dir");

    const moved = await movePathToTrash(target);

    expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(moved)).toBe(profileDir);
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(profileDir, "Preferences"), "utf8")).toBe("profile data");
  });

  it("preserves trash support for dangling in-root symlink entries", async () => {
    const browserDir = path.join(configDir, "browser");
    realMkdirSync(browserDir, { recursive: true });
    const target = path.join(browserDir, "dangling");
    const missingProfile = path.join(browserDir, "missing");
    fs.symlinkSync(missingProfile, target, "dir");

    const moved = await movePathToTrash(target);

    expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(moved)).toBe(missingProfile);
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(missingProfile)).toBe(false);
  });
});
