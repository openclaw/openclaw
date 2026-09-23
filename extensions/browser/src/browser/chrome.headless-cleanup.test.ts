import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";

const fixture = vi.hoisted(() => ({
  root: "",
  alive: true,
  startTime: 123,
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  portProbe: vi.fn(),
  diagnose: vi.fn(),
  trash: vi.fn(),
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: fixture.execFileSync,
  spawn: fixture.spawn,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  isPidAlive: (pid: number) => pid === 4321 && fixture.alive,
  getFileLockProcessStartTime: () => fixture.startTime,
}));

vi.mock("./paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paths.js")>()),
  get DEFAULT_DOWNLOAD_DIR() {
    return path.join(fixture.root, "downloads");
  },
}));
vi.mock("../infra/ports.js", () => ({ ensurePortAvailable: fixture.portProbe }));
vi.mock("./trash.js", () => ({ movePathToTrash: fixture.trash }));
vi.mock("openclaw/plugin-sdk/file-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-lock")>();
  return {
    ...actual,
    // Keep the real exclusion/reentrancy contract; fail contention immediately
    // so regressions prove the boundary without wall-clock sleeps or polling.
    withFileLock: (
      target: string,
      options: import("openclaw/plugin-sdk/file-lock").FileLockOptions,
      run: () => Promise<unknown>,
    ) =>
      actual.withFileLock(target, { ...options, retries: { ...options.retries, retries: 0 } }, run),
  };
});
vi.mock("./chrome.diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.diagnostics.js")>()),
  diagnoseChromeCdp: fixture.diagnose,
}));

import { resolveBrowserExecutableForPlatform } from "./chrome.executables.js";
import {
  launchOpenClawChrome,
  resolveOpenClawUserDataDir,
  stopOwnedOpenClawChrome,
} from "./chrome.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserServerState } from "./server-context.test-harness.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.root = tempDirs.make("openclaw-headless-cleanup-");
  fixture.alive = true;
  fixture.startTime = 123;
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CDP is unavailable")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fixture.execFileSync.mockReset();
  fixture.spawn.mockReset();
  fixture.portProbe.mockReset();
  fixture.diagnose.mockReset();
  fixture.trash.mockReset();
});

function setupOwnedBrowser(
  mode: "explicit" | "cache",
  ownsProfile: boolean,
  configuredHeadless = false,
  platform: "darwin" | "linux" = "darwin",
) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const cache = path.join(fixture.root, "browsers");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const shell = path.join(
    cache,
    "chromium_headless_shell-100",
    platform === "linux"
      ? `chrome-headless-shell-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`
      : `chrome-headless-shell-mac-${arch}`,
    "chrome-headless-shell",
  );
  const chrome = path.join(
    cache,
    "chromium-100",
    ...(platform === "linux"
      ? [`chrome-${process.arch === "arm64" ? "linux-arm64" : "linux64"}`, "chrome"]
      : [
          `chrome-mac-${arch}`,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ]),
  );
  for (const executable of [shell, chrome]) {
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "", { mode: 0o755 });
  }
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", cache);
  const statSync = fs.statSync.bind(fs);
  vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
    if (!String(candidate).startsWith(fixture.root)) {
      throw new Error("ENOENT");
    }
    return statSync(candidate);
  });
  const existsSync = fs.existsSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation(
    (candidate) => String(candidate).startsWith(fixture.root) && existsSync(candidate),
  );
  const resolved = resolveBrowserConfig({
    headless: configuredHeadless,
    ...(mode === "explicit" ? { executablePath: shell } : {}),
  });
  const profile = resolveProfile(resolved, "openclaw")!;
  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  // Full Chrome uses a singleton lock; the real headless shell does not create one.
  if (configuredHeadless) {
    fs.symlinkSync(`${os.hostname()}-4321`, path.join(userDataDir, "SingletonLock"));
  }
  const argv = [
    configuredHeadless ? chrome : shell,
    `--remote-debugging-port=${profile.cdpPort}`,
    `--user-data-dir=${userDataDir}${ownsProfile ? "" : "-other"}`,
    "--headless=new",
  ];
  fixture.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === "ps") {
      if (args.includes("pid=,command=")) {
        return fixture.alive ? `4321 ${argv.join(" ")}\n` : "";
      }
      return argv.join(" ");
    }
    return command === "lsof" && fixture.alive ? "p4321\n" : "";
  });
  if (platform === "linux") {
    const procRoot = path.join(fixture.root, "proc");
    fs.mkdirSync(path.join(procRoot, "4321", "fd"), { recursive: true });
    fs.mkdirSync(path.join(procRoot, "net"), { recursive: true });
    fs.writeFileSync(path.join(procRoot, "4321", "cmdline"), argv.join("\0"));
    fs.symlinkSync("socket:[81234]", path.join(procRoot, "4321", "fd", "3"));
    fs.writeFileSync(
      path.join(procRoot, "net", "tcp"),
      `header\n 0: 0100007F:${profile.cdpPort.toString(16)} 00000000:0000 0A 0:0 00:0 0 1000 0 81234\n`,
    );
    fs.writeFileSync(path.join(procRoot, "net", "tcp6"), "header\n");
    const procPath = (candidate: unknown) =>
      /^\/proc(?:\/|$)/.test(String(candidate))
        ? String(candidate).replace(/^\/proc/, procRoot)
        : undefined;
    const readdirSync = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation((candidate, options) =>
      readdirSync(procPath(candidate) ?? candidate, options),
    );
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((candidate, options) =>
      readFileSync(procPath(candidate) ?? candidate, options),
    );
    const readlinkSync = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, "readlinkSync").mockImplementation((candidate, options) =>
      readlinkSync(procPath(candidate) ?? candidate, options),
    );
  }
  fixture.portProbe.mockImplementation(async () => {
    if (fixture.alive) {
      throw Object.assign(new Error("Port is already in use."), { name: "PortInUseError" });
    }
  });
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(4321);
    expect(signal).toBe("SIGTERM");
    fixture.alive = false;
    return true;
  });
  return { resolved, profile, kill, chrome, shell, userDataDir };
}

it.each(
  (["darwin", "linux"] as const).flatMap((platform) =>
    (["explicit", "cache"] as const).flatMap((mode) =>
      [true, false].map((ownsProfile) => ({ platform, mode, ownsProfile })),
    ),
  ),
)(
  "cleans up a one-shot $platform $mode shell only when ownsProfile=$ownsProfile",
  async ({ platform, mode, ownsProfile }) => {
    const { resolved, profile, kill, chrome, shell } = setupOwnedBrowser(
      mode,
      ownsProfile,
      false,
      platform,
    );
    expect(resolveBrowserExecutableForPlatform(resolved, platform)?.path).toBe(
      mode === "cache" ? chrome : shell,
    );
    expect(
      resolveBrowserExecutableForPlatform({ ...resolved, headless: true }, platform)?.path,
    ).toBe(mode === "cache" ? chrome : shell);
    await expect(stopOwnedOpenClawChrome(resolved, profile, 100)).resolves.toMatchObject({
      status: ownsProfile ? "stopped" : "unverified",
    });
    expect(kill).toHaveBeenCalledTimes(ownsProfile ? 1 : 0);
  },
);

it.each(
  (["linux", "darwin"] as const).flatMap((platform) =>
    (["removed-cache", "changed-executable", "removed-explicit"] as const).flatMap((discovery) =>
      [true, false].map((ownsProfile) => ({ platform, discovery, ownsProfile })),
    ),
  ),
)(
  "identifies a live $platform shell after $discovery only when ownsProfile=$ownsProfile",
  async ({ platform, discovery, ownsProfile }) => {
    const { resolved, profile, kill, shell } = setupOwnedBrowser(
      discovery === "removed-explicit" ? "explicit" : "cache",
      ownsProfile,
      false,
      platform,
    );
    if (discovery === "changed-executable") {
      resolved.executablePath = path.join(fixture.root, "different-browser");
      fs.writeFileSync(resolved.executablePath, "", { mode: 0o755 });
    } else {
      fs.rmSync(path.join(fixture.root, "browsers"), { recursive: true });
      expect(fs.existsSync(shell)).toBe(false);
    }
    await expect(stopOwnedOpenClawChrome(resolved, profile, 100)).resolves.toMatchObject({
      status: ownsProfile ? "stopped" : "unverified",
    });
    expect(kill).toHaveBeenCalledTimes(ownsProfile ? 1 : 0);
  },
);

it.each(["linux", "darwin"] as const)(
  "recovers a %s shell behind a dead local lock",
  async (platform) => {
    const { resolved, profile, kill, userDataDir } = setupOwnedBrowser(
      "cache",
      true,
      false,
      platform,
    );
    fs.symlinkSync(`${os.hostname()}-9876`, path.join(userDataDir, "SingletonLock"));
    await expect(stopOwnedOpenClawChrome(resolved, profile, 100)).resolves.toEqual({
      status: "stopped",
    });
    expect(kill).toHaveBeenCalledOnce();
    expect(fs.readdirSync(userDataDir)).not.toContain("SingletonLock");
  },
);

it.each(["unavailable", "ambiguous"])(
  "does not signal a shell when listener discovery is %s",
  async (discovery) => {
    const { resolved, profile, kill } = setupOwnedBrowser("cache", true);
    fixture.execFileSync.mockImplementation(() => {
      if (discovery === "unavailable") {
        throw new Error("lsof unavailable");
      }
      return "p4321\np9876\n";
    });
    await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
      status: "unverified",
    });
    expect(kill).not.toHaveBeenCalled();
  },
);

it("does not release a lockless full Chrome profile while its CDP port is occupied", async () => {
  const { resolved, profile, kill, userDataDir } = setupOwnedBrowser("cache", true, true);
  fs.unlinkSync(path.join(userDataDir, "SingletonLock"));
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(kill).not.toHaveBeenCalled();
});

it.each([true, false])(
  "fails closed for an explicit Windows shell across runtimes with headless=%s",
  async (headless) => {
    const { resolved, profile, kill, shell } = setupOwnedBrowser("explicit", true);
    const executablePath = `${shell}.exe`;
    fs.writeFileSync(executablePath, "");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    fixture.portProbe.mockResolvedValue(undefined);
    await expect(
      stopOwnedOpenClawChrome({ ...resolved, headless, executablePath }, profile),
    ).resolves.toMatchObject({
      status: "unverified",
      reason: expect.stringContaining("use full Chromium"),
    });
    expect(kill).not.toHaveBeenCalled();
  },
);

it("rejects managed Windows shell launch without spawning or seeding profile data", async () => {
  const { resolved, profile, kill, shell, userDataDir } = setupOwnedBrowser("explicit", true);
  const executablePath = `${shell}.exe`;
  fs.writeFileSync(executablePath, "");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  fixture.portProbe.mockResolvedValue(undefined);
  await expect(
    launchOpenClawChrome({ ...resolved, executablePath }, profile, { headlessOverride: true }),
  ).rejects.toThrow("use full Chromium or attach");
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(kill).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(userDataDir, "Default"))).toBe(false);
});

it("keeps empty Windows full-Chromium profiles releasable", async () => {
  const { resolved, profile, kill, chrome, userDataDir } = setupOwnedBrowser("cache", true, true);
  fs.unlinkSync(path.join(userDataDir, "SingletonLock"));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  fixture.portProbe.mockResolvedValue(undefined);
  await expect(
    stopOwnedOpenClawChrome({ ...resolved, executablePath: chrome }, profile),
  ).resolves.toEqual({ status: "not-running" });
  expect(kill).not.toHaveBeenCalled();
});

it("reports not running only after proving the lockless CDP port is free", async () => {
  const { resolved, profile, kill } = setupOwnedBrowser("cache", true);
  fixture.alive = false;
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toEqual({
    status: "not-running",
  });
  expect(fixture.portProbe).toHaveBeenCalledWith(profile.cdpPort, "127.0.0.1");
  expect(kill).not.toHaveBeenCalled();
});

it("preserves data when shell process discovery fails despite a free CDP port", async () => {
  const { resolved, profile, kill } = setupOwnedBrowser("cache", true);
  fixture.portProbe.mockResolvedValue(undefined);
  fixture.execFileSync.mockImplementation((command) => {
    if (command === "ps") {
      throw new Error("ps unavailable");
    }
    return "";
  });
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(kill).not.toHaveBeenCalled();
});

it.each(
  (["linux", "darwin"] as const).flatMap((platform) =>
    (["stop", "launch"] as const).map((operation) => ({ platform, operation })),
  ),
)(
  "preserves a live $platform shell profile on $operation after the configured CDP port changes",
  async ({ platform, operation }) => {
    const { resolved, profile, kill, userDataDir } = setupOwnedBrowser(
      "cache",
      true,
      false,
      platform,
    );
    fixture.portProbe.mockResolvedValue(undefined);
    const changedProfile = {
      ...profile,
      cdpPort: profile.cdpPort + 1,
      cdpUrl: `http://127.0.0.1:${profile.cdpPort + 1}`,
    };
    if (operation === "stop") {
      await expect(stopOwnedOpenClawChrome(resolved, changedProfile)).resolves.toMatchObject({
        status: "unverified",
      });
    } else {
      await expect(
        launchOpenClawChrome(resolved, changedProfile, { headlessOverride: true }),
      ).rejects.toThrow("headless shell process still uses the profile data");
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(userDataDir, "Default"))).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  },
);

it("preserves a shell profile when its process is alive but no longer listening", async () => {
  const { resolved, profile, kill } = setupOwnedBrowser("cache", true, false, "linux");
  fs.writeFileSync(path.join(fixture.root, "proc", "net", "tcp"), "header\n");
  fixture.portProbe.mockResolvedValue(undefined);
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(kill).not.toHaveBeenCalled();
});

it("preserves a shell profile with duplicate directory flags after the port changes", async () => {
  const { resolved, profile, kill, userDataDir } = setupOwnedBrowser("cache", true, false, "linux");
  fs.appendFileSync(
    path.join(fixture.root, "proc", "4321", "cmdline"),
    `\0--user-data-dir=${userDataDir}`,
  );
  fixture.portProbe.mockResolvedValue(undefined);
  await expect(
    stopOwnedOpenClawChrome(resolved, {
      ...profile,
      cdpPort: profile.cdpPort + 1,
      cdpUrl: `http://127.0.0.1:${profile.cdpPort + 1}`,
    }),
  ).resolves.toMatchObject({ status: "unverified" });
  expect(kill).not.toHaveBeenCalled();
});

it("does not signal a lockless shell after its process identity changes", async () => {
  const { resolved, profile, kill } = setupOwnedBrowser("cache", true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      fixture.startTime += 1;
      throw new Error("CDP is unavailable");
    }),
  );
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(kill).not.toHaveBeenCalled();
});

it("does not release shell profile data when the CDP port remains occupied after shutdown", async () => {
  const { resolved, profile, kill } = setupOwnedBrowser("cache", true);
  fixture.portProbe.mockRejectedValue(new Error("Port is already in use."));
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
    status: "unverified",
  });
  expect(kill).toHaveBeenCalledOnce();
});

it.each(["launch", "reset"] as const)(
  "excludes an independent runtime's %s while the first launch is pending",
  async (operation) => {
    const { resolved, profile, userDataDir } = setupOwnedBrowser("cache", true, false, "linux");
    fixture.alive = false;
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.portProbe.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ Browser: "Chrome/Test" }))),
    );
    fixture.spawn.mockReturnValue(
      Object.assign(new EventEmitter(), {
        pid: 5432,
        exitCode: null,
        signalCode: null,
        stderr: new EventEmitter(),
        kill: vi.fn(),
      }),
    );
    const firstLaunch = launchOpenClawChrome(resolved, profile, { headlessOverride: true });
    await entered.promise;
    try {
      const state = makeBrowserServerState({ profile, resolvedOverrides: resolved });
      const other =
        operation === "launch"
          ? launchOpenClawChrome(resolved, profile, { headlessOverride: true })
          : createBrowserRouteContext({ getState: () => state })
              .forProfile(profile.name)
              .resetProfile();
      await expect(other).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(fixture.trash).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(userDataDir, "Default"))).toBe(false);
    } finally {
      release.resolve();
      await firstLaunch;
    }
    expect(fixture.spawn).toHaveBeenCalledOnce();
  },
);

it("holds cross-runtime exclusion through reset's trash operation, with nested stop ownership", async () => {
  const { resolved, profile, userDataDir } = setupOwnedBrowser("cache", true, false, "linux");
  fixture.alive = false;
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  fixture.trash.mockImplementationOnce(async (target: string) => {
    expect(target).toBe(userDataDir);
    entered.resolve();
    await release.promise;
    const destination = `${userDataDir}-trash`;
    fs.renameSync(userDataDir, destination);
    return destination;
  });
  const state = makeBrowserServerState({ profile, resolvedOverrides: resolved });
  const reset = createBrowserRouteContext({ getState: () => state })
    .forProfile(profile.name)
    .resetProfile();
  await entered.promise;
  try {
    const lockPath = path.join(fixture.root, "browser", `${profile.name}.lifecycle.lock`);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(path.dirname(lockPath)).toBe(path.dirname(path.dirname(userDataDir)));
    await expect(
      launchOpenClawChrome(resolved, profile, { headlessOverride: true }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(fixture.spawn).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await expect(reset).resolves.toMatchObject({ moved: true });
  }
  await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toEqual({
    status: "not-running",
  });
});

it.each([
  {
    configuredHeadless: false,
    ownsProfile: true,
    code: "websocket_health_command_timeout",
    recovers: true,
  },
  {
    configuredHeadless: true,
    ownsProfile: true,
    code: "websocket_health_command_timeout",
    recovers: true,
  },
  {
    configuredHeadless: false,
    ownsProfile: false,
    code: "websocket_health_command_timeout",
    recovers: false,
  },
  {
    configuredHeadless: false,
    ownsProfile: true,
    code: "websocket_health_command_failed",
    recovers: false,
  },
])(
  "recovers stale cache browser with configuredHeadless=$configuredHeadless, ownsProfile=$ownsProfile, code=$code",
  async ({ configuredHeadless, ownsProfile, code, recovers }) => {
    const { resolved, profile, kill, chrome } = setupOwnedBrowser(
      "cache",
      ownsProfile,
      configuredHeadless,
    );
    const portBusy = Object.assign(new Error("Port is already in use."), {
      name: "PortInUseError",
    });
    fixture.portProbe.mockRejectedValueOnce(portBusy).mockResolvedValue(undefined);
    fixture.diagnose.mockResolvedValue({ ok: false, code, cdpUrl: profile.cdpUrl });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ Browser: "Chrome/Test" }))),
    );
    const proc = Object.assign(new EventEmitter(), {
      pid: 5432,
      exitCode: null,
      signalCode: null,
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    fixture.spawn.mockReturnValue(proc);
    const launch = launchOpenClawChrome(resolved, profile, {
      headlessOverride: true,
      platform: "darwin",
      env: {},
    });
    if (recovers) {
      await expect(launch).resolves.toMatchObject({ exe: { path: chrome }, proc });
      expect(fixture.portProbe).toHaveBeenCalledTimes(2);
      expect(fixture.spawn).toHaveBeenCalledTimes(1);
    } else {
      await expect(launch).rejects.toBe(portBusy);
      expect(fixture.spawn).not.toHaveBeenCalled();
    }
    expect(kill).toHaveBeenCalledTimes(recovers ? 1 : 0);
  },
);
