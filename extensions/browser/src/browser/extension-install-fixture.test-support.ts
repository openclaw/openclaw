import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectPathPermissions } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { vi } from "vitest";
import { chromeStoreInstallRequests as readChromeStoreInstallRequests } from "./extension-install-external.js";
import * as layout from "./extension-install-layout.js";
import * as registration from "./extension-install-registration.js";
import type { NativeWindowsContext } from "./extension-windows-contract.js";
import * as windows from "./extension-windows-host.js";
import { runWindowsManagement } from "./extension-windows-management.js";
import {
  createWindowsNativePlatform,
  type WindowsNativePlatform,
} from "./extension-windows-platform.js";

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
  return { ...actual, createWindowsNativePlatform: vi.fn(actual.createWindowsNativePlatform) };
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
    platform?: WindowsNativePlatform;
    manage?: typeof runWindowsManagement;
    context?: NativeWindowsContext;
    executable?: string;
  };
};

function selectFixture(fixture: InstallFixture = {}) {
  const restores: Array<() => void> = [];
  const property = (name: "platform" | "execPath" | "argv", value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)!;
    Object.defineProperty(process, name, { ...descriptor, value });
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
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
    restores.push(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
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
    vi.mocked(createWindowsNativePlatform).mockReturnValue(native.platform);
    restores.push(() => vi.mocked(createWindowsNativePlatform).mockReset());
  }
  if (native?.manage) {
    vi.mocked(runWindowsManagement).mockImplementation(native.manage);
    restores.push(() => vi.mocked(runWindowsManagement).mockReset());
  }
  if (native?.context) {
    const context = native.context;
    property("execPath", context.nodePath);
    property("argv", [
      context.nodePath,
      context.cliPath,
      "--browser-profile",
      context.browserProfile,
    ]);
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

export function chromeProductRoots(fixture?: InstallFixture) {
  const restore = selectFixture(fixture);
  try {
    return layout.chromeProductRoots();
  } finally {
    restore();
  }
}
export function stableChromeExtensionDir(fixture?: InstallFixture) {
  const restore = selectFixture(fixture);
  try {
    return layout.stableChromeExtensionDir();
  } finally {
    restore();
  }
}
export function installStableChromeExtension(bundledDir: string, fixture?: InstallFixture) {
  return inFixture(fixture, () => layout.installStableChromeExtension(bundledDir));
}
export function resolveChromeExtensionLoadPath(bundledDir: string, fixture?: InstallFixture) {
  return inFixture(fixture, () => installer.resolveChromeExtensionLoadPath(bundledDir));
}
export function discoverChromeExtensionIds(
  params: Parameters<typeof layout.discoverChromeExtensionIds>[0] & { deps?: InstallFixture },
) {
  return inFixture(params.deps, () => layout.discoverChromeExtensionIds(params));
}
export function installChromeExtensionBootstrap(
  params: Parameters<typeof installer.installChromeExtensionBootstrap>[0] & {
    deps?: InstallFixture;
  },
) {
  return inFixture(
    params.deps,
    () =>
      installer.installChromeExtensionBootstrap({
        ...params,
        nativeHostExecutable: params.nativeHostExecutable ?? params.deps?.windowsNative?.executable,
      }),
    params.pluginRoot,
  );
}
export function browserExtensionStatus(
  params: Parameters<typeof installer.browserExtensionStatus>[0] & { deps?: InstallFixture },
) {
  return inFixture(params.deps, () =>
    installer.browserExtensionStatus({
      ...params,
      nativeHostExecutable: params.nativeHostExecutable ?? params.deps?.windowsNative?.executable,
    }),
  );
}
export function installRegistration(
  params: Parameters<typeof registration.installRegistration>[0] & { deps?: InstallFixture },
) {
  return inFixture(params.deps, () => registration.installRegistration(params), params.pluginRoot);
}
export function repairChromeExtensionNativeHosts(
  params: Parameters<typeof installer.repairChromeExtensionNativeHosts>[0] & {
    deps?: InstallFixture;
  },
) {
  return inFixture(
    params.deps,
    () => installer.repairChromeExtensionNativeHosts(params),
    params.pluginRoot,
  );
}
export function uninstallChromeExtensionNativeHosts(
  params: NonNullable<Parameters<typeof installer.uninstallChromeExtensionNativeHosts>[0]> & {
    deps?: InstallFixture;
  },
) {
  return inFixture(params.deps, () =>
    installer.uninstallChromeExtensionNativeHosts({
      ...params,
      nativeHostExecutable: params.nativeHostExecutable ?? params.deps?.windowsNative?.executable,
    }),
  );
}
export function removeChromeStoreInstallRequests(fixture?: InstallFixture) {
  return inFixture(fixture, () => installer.removeChromeStoreInstallRequests());
}
export function chromeStoreInstallRequests(fixture?: InstallFixture) {
  return inFixture(fixture, () => readChromeStoreInstallRequests());
}
export function installWindowsNativeHost(
  params: Parameters<typeof windows.installWindowsNativeHost>[0] & { deps?: InstallFixture },
) {
  return inFixture(params.deps, () =>
    windows.installWindowsNativeHost({
      ...params,
      executable: params.executable ?? params.deps?.windowsNative?.executable,
    }),
  );
}
export function inspectWindowsNativeHosts(
  params: NonNullable<Parameters<typeof windows.inspectWindowsNativeHosts>[0]> & {
    deps?: InstallFixture;
  },
) {
  return inFixture(params.deps, () =>
    windows.inspectWindowsNativeHosts({
      ...params,
      executable: params.executable ?? params.deps?.windowsNative?.executable,
    }),
  );
}
export function uninstallWindowsNativeHosts(
  params: NonNullable<Parameters<typeof windows.uninstallWindowsNativeHosts>[0]> & {
    deps?: InstallFixture;
  },
) {
  return inFixture(params.deps, () =>
    windows.uninstallWindowsNativeHosts({
      ...params,
      executable: params.executable ?? params.deps?.windowsNative?.executable,
    }),
  );
}
export function validateWindowsNativeContext(
  params: Parameters<typeof windows.validateWindowsNativeContext>[0],
  fixture?: InstallFixture,
) {
  return inFixture(fixture, () => windows.validateWindowsNativeContext(params));
}
