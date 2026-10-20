import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const browserUtilsMock = vi.hoisted(() => ({ configDir: "/tmp/openclaw-state" }));

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
  let trashDir = "";

  function write(target: string, contents: string) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
  }
  function profile(dir: string, contents = "outside profile") {
    write(path.join(dir, "Preferences"), contents);
    return dir;
  }
  function expectOutsideProfile(dir: string) {
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "Preferences"), "utf8")).toBe("outside profile");
  }
  function expectForbidden(target: string) {
    return expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    testRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-")));
    configDir = path.join(testRoot, "state");
    homeDir = path.join(testRoot, "home", "test");
    trashDir = path.join(homeDir, ".Trash");
    browserUtilsMock.configDir = configDir;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("allows managed browser data under a configured state directory outside home", async () => {
    const target = profile(path.join(configDir, "browser", "constructor"), "profile data");

    const moved = await movePathToTrash(target);
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
    await expectForbidden(write(path.join(configDir, "credentials", "token.json"), "secret"));
  });

  it("does not grant arbitrary filesystem authority for a root config directory", async () => {
    browserUtilsMock.configDir = path.parse(testRoot).root;
    await expectForbidden(write(path.join(testRoot, "outside-root-browser"), "outside"));
  });

  it("trashes an in-root symlink entry without moving its outside profile", async () => {
    const browserDir = path.join(configDir, "browser");
    const outsideDir = profile(path.join(testRoot, "outside-profile"));
    fs.mkdirSync(browserDir, { recursive: true });
    const target = path.join(browserDir, "constructor");
    fs.symlinkSync(outsideDir, target, "dir");

    const moved = await movePathToTrash(target);

    expect(fs.lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(moved)).toBe(outsideDir);
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expectOutsideProfile(outsideDir);
    expect(fs.readdirSync(outsideDir)).toEqual(["Preferences"]);
    const reservation = path.dirname(moved);
    expect(path.dirname(reservation)).toBe(trashDir);
    expect(fs.readdirSync(trashDir)).toEqual([path.basename(reservation)]);
    expect(fs.readdirSync(reservation)).toEqual([path.basename(target)]);
  });

  it("rejects entries whose symlinked parent resolves outside the Browser root", async () => {
    const browserDir = path.join(configDir, "browser");
    const outsideDir = path.join(testRoot, "outside-profile");
    const outsideTarget = profile(path.join(outsideDir, "nested", "profile"));
    fs.mkdirSync(browserDir, { recursive: true });
    const parentAlias = path.join(browserDir, "escaped-parent");
    fs.symlinkSync(outsideDir, parentAlias, "dir");
    const target = path.join(parentAlias, "nested", "profile");

    await expectForbidden(target);
    expect(fs.readlinkSync(parentAlias)).toBe(outsideDir);
    expectOutsideProfile(outsideTarget);
    expect(fs.readdirSync(trashDir)).toEqual([]);
  });
});
