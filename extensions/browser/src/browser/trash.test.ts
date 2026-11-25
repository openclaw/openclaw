import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

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

let testRoot = "";
let configDir = "";
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
  const homeDir = path.join(testRoot, "home", "test");
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
  expect(path.dirname(reservation)).toBe(trashDir);
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

it.each([false, true])("rejects paths outside Browser authority (root=%s)", async (root) => {
  if (root) {
    browserUtilsMock.configDir = path.parse(testRoot).root;
  }
  const target = root
    ? path.join(testRoot, "outside-root-browser")
    : path.join(configDir, "credentials", "token.json");
  await expectForbidden(write(target, "data"));
});

it.each([false, true])("confines symlink moves (parent=%s)", async (parent) => {
  const browserDir = path.join(configDir, "browser");
  const outsideDir = path.join(testRoot, "outside-profile");
  const outsideTarget = profile(parent ? path.join(outsideDir, "nested", "profile") : outsideDir);
  fs.mkdirSync(browserDir, { recursive: true });
  const alias = path.join(browserDir, parent ? "escaped-parent" : "constructor");
  fs.symlinkSync(outsideDir, alias, "dir");
  const target = parent ? path.join(alias, "nested", "profile") : alias;
  let link = alias;
  if (parent) {
    await expectForbidden(target);
    expect(fs.readdirSync(trashDir)).toEqual([]);
  } else {
    link = await movePathToTrash(target);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readdirSync(outsideDir)).toEqual(["Preferences"]);
    const reservation = path.dirname(link);
    expect(path.dirname(reservation)).toBe(trashDir);
    expect(fs.readdirSync(trashDir)).toEqual([path.basename(reservation)]);
    expect(fs.readdirSync(reservation)).toEqual([path.basename(target)]);
  }
  expect(fs.readlinkSync(link)).toBe(outsideDir);
  expectOutsideProfile(outsideTarget);
});
