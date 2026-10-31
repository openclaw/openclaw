import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectPathPermissions } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { vi } from "vitest";
import { chromeStoreInstallRequests as readChromeStoreInstallRequests } from "./extension-install-external.js";
import * as layout from "./extension-install-layout.js";
import * as registration from "./extension-install-registration.js";
import {
  useExtensionInstallFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";
import type { NativeWindowsContext } from "./extension-windows-contract.js";
import * as windows from "./extension-windows-host.js";
import { runWindowsManagement } from "./extension-windows-management.js";
import { windowsNativePlatform } from "./extension-windows-platform.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return { ...actual, inspectPathPermissions: vi.fn(actual.inspectPathPermissions) };
});
vi.mock("openclaw/plugin-sdk/state-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/state-paths")>();
  return {
    ...actual,
    resolveConfigPath: vi.fn(actual.resolveConfigPath),
    resolveStateDir: vi.fn(actual.resolveStateDir),
  };
});
vi.mock("./extension-windows-platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-windows-platform.js")>();
  return { ...actual, windowsNativePlatform: { ...actual.windowsNativePlatform } };
});
vi.mock("./extension-windows-management.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-windows-management.js")>();
  return { ...actual, runWindowsManagement: vi.fn(actual.runWindowsManagement) };
});

const installer =
  await vi.importActual<typeof import("./extension-install.js")>("./extension-install.js");

export type InstallFixture = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  homeDir?: string;
  nodePath?: string;
  nativeHostPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  windowsNative?: {
    platform?: typeof windowsNativePlatform;
    manage?: typeof runWindowsManagement;
    context?: NativeWindowsContext;
    executable?: string;
  };
};

export function withAdvancingInstallClock(deps: InstallFixture) {
  let now = 0;
  return {
    ...deps,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function selectFixture(fixture: InstallFixture = {}) {
  const restores: Array<() => void> = [];
  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  const property = (name: "platform" | "execPath" | "argv", value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)!;
    // A data override must not retain an accessor's get/set fields.
    Object.defineProperty(process, name, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      writable: descriptor.writable ?? true,
      value,
    });
    restores.push(() => Object.defineProperty(process, name, descriptor));
  };
  if (fixture.platform) {
    property("platform", fixture.platform);
  }
  if (fixture.nodePath) {
    property("execPath", fixture.nodePath);
  }
  const env: NodeJS.ProcessEnv = {
    ...fixture.env,
    HOME: fixture.homeDir ?? fixture.env?.HOME,
    OPENCLAW_STATE_DIR: fixture.stateDir ?? fixture.env?.OPENCLAW_STATE_DIR,
  };
  for (const key of new Set([
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "CHROME_CONFIG_HOME",
    ...Object.keys(env),
  ])) {
    const previous = process.env[key];
    setEnv(key, env[key]);
    restores.push(() => setEnv(key, previous));
  }
  if (fixture.now) {
    const now = vi.spyOn(Date, "now").mockImplementation(fixture.now);
    restores.push(() => now.mockRestore());
  }
  if (fixture.sleep) {
    vi.mocked(sleep).mockImplementation(async (ms) => await fixture.sleep!(ms ?? 0));
    restores.push(() => vi.mocked(sleep).mockReset());
  }
  if (fixture.platform === "win32") {
    vi.mocked(inspectPathPermissions).mockResolvedValue({
      ok: true,
      isSymlink: false,
      isDir: false,
      mode: null,
      bits: null,
      source: "windows-acl",
      ownerTrusted: true,
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
    });
    restores.push(() => vi.mocked(inspectPathPermissions).mockReset());
  }
  const native = fixture.windowsNative;
  if (native?.platform) {
    const previous = { ...windowsNativePlatform };
    Object.assign(windowsNativePlatform, native.platform);
    restores.push(() => Object.assign(windowsNativePlatform, previous));
  }
  if (native?.manage) {
    vi.mocked(runWindowsManagement).mockImplementation(native.manage);
    restores.push(() => vi.mocked(runWindowsManagement).mockReset());
  }
  if (native?.context) {
    const context = native.context;
    const { nodePath, cliPath, browserProfile } = context;
    property("execPath", nodePath);
    property("argv", [nodePath, cliPath, "--browser-profile", browserProfile]);
    vi.mocked(resolveStateDir).mockImplementation((selectedEnv) =>
      selectedEnv ? context.stateDir : (fixture.stateDir ?? context.stateDir),
    );
    vi.mocked(resolveConfigPath).mockReturnValue(context.configPath);
    restores.push(() => vi.mocked(resolveStateDir).mockReset());
    restores.push(() => vi.mocked(resolveConfigPath).mockReset());
    const realpath = fs.realpath.bind(fs);
    const cli = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (...args) =>
        String(args[0]).endsWith("openclaw.mjs") ? context.cliPath : await realpath(...args),
      );
    restores.push(() => cli.mockRestore());
  }
  return () => restores.toReversed().forEach((restore) => restore());
}

async function inFixture<T>(
  fixture: InstallFixture | undefined,
  run: () => Promise<T>,
  pluginRoot?: string,
) {
  // Resolve the real fixture entry through the same package lookup used by install.
  if (pluginRoot && fixture?.nativeHostPath) {
    const entry = path.join(pluginRoot, "native-host-entry.js");
    if (entry !== fixture.nativeHostPath) {
      const existing = await fs.lstat(entry).catch(() => undefined);
      if (existing && !existing.isSymbolicLink()) {
        throw new Error("Fixture entry must be a symlink");
      }
      if (existing) {
        await fs.unlink(entry);
      }
      await fs.symlink(fixture.nativeHostPath, entry);
    }
  }
  const restore = selectFixture(fixture);
  try {
    return await run();
  } finally {
    restore();
  }
}

type FixtureParams = { deps?: InstallFixture };

function withParams<P, R>(
  run: (params: P) => Promise<R>,
  map: (params: P & FixtureParams) => P = (params) => params,
  pluginRoot?: (params: P) => string,
) {
  return (params: P & FixtureParams) =>
    inFixture(params.deps, () => run(map(params)), pluginRoot?.(params));
}

function nativeExecutable<P extends FixtureParams & { nativeHostExecutable?: string }>(params: P) {
  return {
    ...params,
    nativeHostExecutable: params.nativeHostExecutable ?? params.deps?.windowsNative?.executable,
  };
}

function windowsExecutable<P extends FixtureParams & { executable?: string }>(params: P) {
  return { ...params, executable: params.executable ?? params.deps?.windowsNative?.executable };
}

function selected<T>(fixture: InstallFixture | undefined, run: () => T): T {
  const restore = selectFixture(fixture);
  try {
    return run();
  } finally {
    restore();
  }
}

export const chromeProductRoots = (fixture?: InstallFixture) =>
  selected(fixture, layout.chromeProductRoots);
export const stableChromeExtensionDir = (fixture?: InstallFixture) =>
  selected(fixture, layout.stableChromeExtensionDir);
export const installStableChromeExtension = (bundledDir: string, fixture?: InstallFixture) =>
  inFixture(fixture, () => layout.installStableChromeExtension(bundledDir));
export const resolveChromeExtensionLoadPath = (bundledDir: string, fixture?: InstallFixture) =>
  inFixture(fixture, () => installer.resolveChromeExtensionLoadPath(bundledDir));
export const discoverChromeExtensionIds = withParams(layout.discoverChromeExtensionIds);
export const installChromeExtensionBootstrap = withParams(
  installer.installChromeExtensionBootstrap,
  nativeExecutable,
  (params) => params.pluginRoot,
);
export const browserExtensionStatus = withParams(
  installer.browserExtensionStatus,
  nativeExecutable,
);
export const installRegistration = withParams(
  registration.installRegistration,
  undefined,
  (params) => params.pluginRoot,
);
export const repairChromeExtensionNativeHosts = withParams(
  installer.repairChromeExtensionNativeHosts,
  undefined,
  (params) => params.pluginRoot,
);
export const uninstallChromeExtensionNativeHosts = withParams(
  installer.uninstallChromeExtensionNativeHosts,
  nativeExecutable,
);
export const removeChromeStoreInstallRequests = (fixture?: InstallFixture) =>
  inFixture(fixture, () => installer.removeChromeStoreInstallRequests());
export const chromeStoreInstallRequests = (fixture?: InstallFixture) =>
  inFixture(fixture, () => readChromeStoreInstallRequests());
export const installWindowsNativeHost = withParams(
  windows.installWindowsNativeHost,
  windowsExecutable,
);
export const inspectWindowsNativeHosts = withParams(
  windows.inspectWindowsNativeHosts,
  windowsExecutable,
);
export const uninstallWindowsNativeHosts = withParams(
  windows.uninstallWindowsNativeHosts,
  windowsExecutable,
);
export const validateWindowsNativeContext = (
  params: Parameters<typeof windows.validateWindowsNativeContext>[0],
  fixture?: InstallFixture,
) => inFixture(fixture, () => windows.validateWindowsNativeContext(params));

/** Shared filesystem fixture with operations bound to its selected install context. */
export function useInstallFixture() {
  const create = useExtensionInstallFixture();
  return async (platform?: NodeJS.Platform) => {
    const value = await create(platform);
    const productRoot = (product: layout.ChromeProduct = "chrome") => {
      const root = chromeProductRoots(value.deps).find((entry) => entry.product === product);
      if (!root) {
        throw new Error(`missing ${product} fixture root`);
      }
      return root;
    };
    return {
      ...value,
      productRoot,
      install: (options: Partial<Parameters<typeof installChromeExtensionBootstrap>[0]> = {}) =>
        installChromeExtensionBootstrap({ ...value, waitMs: 1_000, ...options }),
      installCopy: () => installStableChromeExtension(value.bundledDir, value.deps),
      loadPath: () => resolveChromeExtensionLoadPath(value.bundledDir, value.deps),
      preferences: (
        entries: Record<string, unknown>,
        filename: "Preferences" | "Secure Preferences" = "Preferences",
        profile = "Default",
      ) =>
        writeChromePreferences({
          userDataDir: productRoot().userDataDir,
          profile,
          entries,
          filename,
        }),
      discover: (approvedDirs = [value.bundledDir], storeExtensionId?: string) =>
        discoverChromeExtensionIds({ approvedDirs, storeExtensionId, deps: value.deps }),
    };
  };
}
