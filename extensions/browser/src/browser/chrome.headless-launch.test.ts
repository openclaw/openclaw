import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const fixture = vi.hoisted(() => ({ root: "", spawn: vi.fn() }));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
vi.mock("./paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paths.js")>()),
  get DEFAULT_DOWNLOAD_DIR() {
    return path.join(fixture.root, "downloads");
  },
}));
vi.mock("../infra/ports.js", () => ({ ensurePortAvailable: async () => {} }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: fixture.spawn,
}));

import { launchOpenClawChrome, resolveOpenClawUserDataDir } from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.root = tempDirs.make("openclaw-headless-launch-");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ Browser: "Chrome/Test" }))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.spawn.mockReset();
});

it.each(["linux", "darwin", "win32"] as const)(
  "seeds a fresh headless profile before its only launch on %s, preserving prefs on reuse",
  async (platform) => {
    const executablePath = path.join(fixture.root, "chrome");
    fs.writeFileSync(executablePath, "");
    const resolved = resolveBrowserConfig({ executablePath });
    const profile = resolveProfile(resolved, "openclaw")!;
    const userDataDir = resolveOpenClawUserDataDir(profile.name);
    const preferencesPath = path.join(userDataDir, "Default", "Preferences");
    const readPrefs = () => JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    fixture.spawn.mockImplementation((_command, args: string[]) => {
      expect(args).toContain("--headless=new");
      expect(args).not.toContain("--no-sandbox");
      expect(readPrefs()).toMatchObject({
        download: {
          default_directory: path.join(fixture.root, "downloads"),
          prompt_for_download: false,
        },
        net: { network_prediction_options: 2 },
        profile: { name: "openclaw" },
      });
      return proc;
    });

    const running = await launchOpenClawChrome(resolved, profile, {
      env: { DISPLAY: ":99" },
      platform,
    });
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(running).toMatchObject({ headless: true, headlessSource: "default", proc });
    const prefs = readPrefs();
    prefs.custom = { preserved: true };
    fs.writeFileSync(preferencesPath, JSON.stringify(prefs));
    await launchOpenClawChrome(resolved, profile, { env: {}, platform });
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(readPrefs().custom).toEqual({ preserved: true });
  },
);

it("rejects an actual headed launch of an explicit headless-only executable", async () => {
  const executablePath = path.join(fixture.root, "chrome-headless-shell");
  fs.writeFileSync(executablePath, "");
  const resolved = resolveBrowserConfig({ executablePath, headless: false });
  await expect(
    launchOpenClawChrome(resolved, resolveProfile(resolved, "openclaw")!, {
      env: { DISPLAY: ":99" },
      platform: "linux",
    }),
  ).rejects.toThrow("cannot open a headed window");
  expect(fixture.spawn).not.toHaveBeenCalled();
});
