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

  it("rejects browser-subtree symlinks that escape the configured state directory", async () => {
    const browserDir = path.join(configDir, "browser");
    const outsideDir = path.join(testRoot, "outside-profile");
    realMkdirSync(browserDir, { recursive: true });
    realMkdirSync(outsideDir, { recursive: true });
    const target = path.join(browserDir, "constructor");
    fs.symlinkSync(outsideDir, target, "dir");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });
});
