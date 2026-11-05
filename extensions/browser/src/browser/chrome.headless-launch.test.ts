import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const fixture = vi.hoisted(() => ({
  root: "",
  spawn: vi.fn(),
  processListingBytes: undefined as number | undefined,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
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
vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  ensurePortAvailable: async () => {},
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: fixture.spawn,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (
        fixture.processListingBytes !== undefined &&
        args[0] === "ps" &&
        Array.isArray(args[1]) &&
        args[1].includes("pid=,command=")
      ) {
        // Keep the real subprocess capture limit; only the process listing is synthetic.
        return actual.execFileSync(
          process.execPath,
          [
            "-e",
            "process.stdout.write('123 /unrelated ' + 'x'.repeat(Number(process.argv[1])) + '\\n')",
            String(fixture.processListingBytes),
          ],
          args[2],
        );
      }
      return actual.execFileSync(...args);
    },
  };
});

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
  fixture.processListingBytes = undefined;
});

it.each([
  { platform: "linux", largeProcessListing: false },
  { platform: "darwin", largeProcessListing: false },
  { platform: "win32", largeProcessListing: false },
  { platform: "darwin", largeProcessListing: true },
] as const)(
  "seeds a fresh headless profile before its only launch on $platform (large listing: $largeProcessListing)",
  async ({ platform, largeProcessListing }) => {
    if (largeProcessListing) {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      fixture.processListingBytes = 2 * 1024 * 1024;
    }
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
    if (process.platform !== "win32") {
      expect(fs.statSync(preferencesPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(userDataDir, "Local State")).mode & 0o777).toBe(0o600);
    }
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

it.each([
  { headless: true, extraArgs: [], normalize: true },
  { headless: false, extraArgs: [], normalize: false },
  { headless: true, extraArgs: ["--user-agent=CustomBrowser/1"], normalize: false },
  { headless: true, extraArgs: ["--user-agent", "CustomBrowser/1"], normalize: false },
])("preserves native version, platform, and explicit identity: %j", async (testCase) => {
  const executablePath = path.join(fixture.root, "chrome");
  fs.writeFileSync(executablePath, "");
  const nativeIdentity = "Mozilla/5.0 (X11; Linux aarch64) HeadlessChrome/153.0.0.0 Safari/537.36";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ Browser: "Chrome/Test", "User-Agent": nativeIdentity })),
    ),
  );
  const resolved = resolveBrowserConfig({ executablePath, ...testCase });
  const profile = resolveProfile(resolved, "openclaw")!;
  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "Local State"), "{}");
  fs.writeFileSync(path.join(userDataDir, "Default", "Preferences"), "{}");
  const processes: EventEmitter[] = [];
  fixture.spawn.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      stderr: new EventEmitter(),
      kill: vi.fn((signal: NodeJS.Signals) => {
        proc.signalCode = signal;
        proc.emit("exit", null, signal);
        return true;
      }),
    });
    processes.push(proc);
    return proc;
  });
  const running = await launchOpenClawChrome(resolved, profile, {
    env: { DISPLAY: ":99" },
    platform: "linux",
  });
  const args: string[] = fixture.spawn.mock.calls.at(-1)![1];
  expect(args.filter((arg) => arg.startsWith("--user-agent"))).toEqual(
    testCase.normalize
      ? ["--user-agent=Mozilla/5.0 (X11; Linux aarch64) Chrome/153.0.0.0 Safari/537.36"]
      : testCase.extraArgs.filter((arg) => arg.startsWith("--user-agent")),
  );
  expect(processes).toHaveLength(testCase.normalize ? 2 : 1);
  expect(running.proc).toBe(processes.at(-1));
});

it("refuses launch when the process listing exceeds the bounded capture", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  fixture.processListingBytes = 5 * 1024 * 1024;
  const resolved = resolveBrowserConfig({});
  const profile = resolveProfile(resolved, "openclaw")!;
  await expect(launchOpenClawChrome(resolved, profile)).rejects.toThrow(
    "Headless shell profile ownership could not be verified",
  );
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fs.existsSync(resolveOpenClawUserDataDir(profile.name))).toBe(false);
});
