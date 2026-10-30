/** Filesystem-only binary recognition shared by selection and managed startup. */
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type { CodexManagedCommandOrder } from "./config-contracts.js";
import { resolveMacOSDesktopCodexAppServerCommandCandidates } from "./desktop-app-paths.js";
import { MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

// Mirrors the official launcher; native startup remains owned by its npm entrypoint.
const NATIVE_TARGET_TRIPLES = new Map([
  ["linux-x64", "x86_64-unknown-linux-musl"],
  ["linux-arm64", "aarch64-unknown-linux-musl"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["win32-x64", "x86_64-pc-windows-msvc"],
  ["win32-arm64", "aarch64-pc-windows-msvc"],
]);

// Registration and lazy runtime artifacts can load separate module copies.
// They must resolve dependencies from the same loader-owned plugin root.
export const registeredCodexPlugin = resolveGlobalSingleton<{ root?: string }>(
  Symbol.for("openclaw.codexManagedPluginRoot"),
  () => ({}),
);

/** A user-installed Codex that passed the version policy and an app-server handshake. */
export type InstalledCodexAppServer = {
  command: string;
  nativeCommand: string;
  version: string;
};

type InstalledCodexAppServerState = {
  selection?: Promise<InstalledCodexAppServer | undefined>;
  pending?: boolean;
  selected?: InstalledCodexAppServer;
  /** Launcher dropped after a failed start; concurrent starts of it still fall back. */
  rejected?: string;
};

// One decision per process, so model discovery and every managed start agree on
// the binary. A Gateway restart drains the slot and the next start re-resolves.
export const installedCodex = resolveGlobalSingleton<InstalledCodexAppServerState>(
  Symbol.for("openclaw.codexInstalledAppServer"),
  () => ({}),
  (state) => {
    delete state.selection;
    delete state.selected;
    delete state.pending;
    delete state.rejected;
  },
);

type ResolveManagedCodexNativeCommandOptions = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  pathExists?: (filePath: string) => boolean;
  resolvePackageJson?: (packageName: string, root: string) => string | undefined;
};

/** Records the process-stable plugin root prepared by OpenClaw's plugin loader. */
export function setManagedCodexPluginRoot(pluginRoot: string | undefined): void {
  registeredCodexPlugin.root = pluginRoot;
}

/** Accepts native executables and the official npm launcher, never other script wrappers. */
export function resolveInstalledCodexLauncher(
  found: string,
  platform: NodeJS.Platform,
): { command: string; nativeCommand: string } | undefined {
  let command: string;
  try {
    command = realpathSync(found);
    if (platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(command)) {
      // npm's Windows shims sit beside the global node_modules directory.
      command = realpathSync(
        path.join(path.dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js"),
      );
    }
  } catch {
    return undefined;
  }
  const packagedNative = resolvePackagedCodexNativeCommand(command);
  if (packagedNative) {
    return { command, nativeCommand: packagedNative };
  }
  if (/\.(?:[cm]?js|cmd|bat|ps1)$/iu.test(command) || startsWithShebang(command)) {
    return undefined;
  }
  return { command, nativeCommand: command };
}

function startsWithShebang(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return true;
  }
  try {
    const buffer = Buffer.alloc(2);
    return readSync(fd, buffer, 0, 2, 0) === 2 && buffer.toString("latin1") === "#!";
  } finally {
    closeSync(fd);
  }
}

/** Resolves the native artifact behind a successful managed launcher selection. */
export function resolveManagedCodexNativeCommand(
  command: string,
  options: ResolveManagedCodexNativeCommandOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const installedNative = installedCodex.selected;
  if (installedNative?.command === command) {
    return installedNative.nativeCommand;
  }
  if (isManagedCodexDesktopCommand(command, platform)) {
    return command;
  }
  const target = `${platform === "android" ? "linux" : platform}-${options.arch ?? process.arch}`;
  const triple = NATIVE_TARGET_TRIPLES.get(target);
  if (!triple) {
    return undefined;
  }
  const packageRoot = resolveManagedCodexPackageRootForCommand(command, platform);
  if (!packageRoot) {
    return undefined;
  }
  const resolvePackageJson = options.resolvePackageJson ?? resolvePackageJsonFromRoot;
  const pathExists = options.pathExists ?? existsSync;
  // The npm entrypoint selects the platform package before checking its binary.
  // An incomplete platform package must not attest a different embedded executable.
  const packageJsonPath =
    resolvePackageJson(`@openai/codex-${target}`, packageRoot) ??
    resolvePackageJson(MANAGED_CODEX_APP_SERVER_PACKAGE, packageRoot);
  if (!packageJsonPath) {
    return undefined;
  }
  const candidate = path.join(
    path.dirname(packageJsonPath),
    "vendor",
    triple,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  return pathExists(candidate) ? candidate : undefined;
}

/** Recognizes only the official npm entrypoint, not arbitrary configured wrappers. */
export function resolvePackagedCodexNativeCommand(entrypoint: string): string | undefined {
  const packageRoot = path.dirname(path.dirname(entrypoint));
  if (
    path.basename(packageRoot) !== "codex" ||
    path.basename(path.dirname(packageRoot)) !== "@openai" ||
    path.relative(packageRoot, entrypoint) !== path.join("bin", "codex.js")
  ) {
    return undefined;
  }
  return resolveManagedCodexNativeCommand(entrypoint);
}

export function isManagedCodexDesktopCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "darwin" &&
    resolveMacOSDesktopCodexAppServerCommandCandidates(platform).includes(command)
  );
}

function resolveManagedCodexPackageRootForCommand(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const commandPaths = [command];
  try {
    commandPaths.unshift(realpathSync(command));
  } catch {
    // Lexical .bin shims still identify their adjacent package root.
  }
  for (const commandPath of commandPaths) {
    let current = pathApi.dirname(commandPath);
    while (true) {
      if (
        pathApi.basename(current) === "codex" &&
        pathApi.basename(pathApi.dirname(current)) === "@openai"
      ) {
        return current;
      }
      if (pathApi.basename(current) === ".bin") {
        return pathApi.join(pathApi.dirname(current), "@openai", "codex");
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return undefined;
}

function resolvePackageJsonFromRoot(packageName: string, root: string): string | undefined {
  try {
    const manifestPath = realpathSync(path.join(root, "package.json"));
    return createRequire(manifestPath).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

export function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
  managedCommandOrder: CodexManagedCommandOrder,
  installedCommand: string | undefined,
): string[] {
  const packageCommand = resolveManagedCodexPackageEntrypoint(pluginRoot);
  // A newer installed Codex replaces the pinned package as the primary choice;
  // the package stays next as the fallback for a failed first start.
  const packageCommandPaths = [installedCommand, packageCommand].filter(
    (command): command is string => command !== undefined,
  );
  if (managedCommandOrder === "package-only") {
    return packageCommandPaths;
  }
  const desktopCommandPaths = resolveMacOSDesktopCodexAppServerCommandCandidates(platform);
  // Ordinary turns prefer the package selection. Computer Use opts into the
  // desktop app owner because its macOS TCC permissions live there.
  return managedCommandOrder === "desktop-first"
    ? [...desktopCommandPaths, ...packageCommandPaths]
    : [...packageCommandPaths, ...desktopCommandPaths];
}

export function resolveManagedCodexPackageEntrypoint(pluginRoot: string): string | undefined {
  try {
    // Use the pinned package's official launcher on every OS. It owns platform
    // selection, manager environment markers, signal forwarding, and exit status.
    return createRequire(path.join(pluginRoot, "package.json")).resolve(
      `${MANAGED_CODEX_APP_SERVER_PACKAGE}/bin/codex.js`,
    );
  } catch {
    return undefined;
  }
}

/** Presence only: version and initialize health remain startup's responsibility. */
export function hasManagedCodexAppServerBinary(): boolean {
  if (installedCodex.selected && existsSync(installedCodex.selected.nativeCommand)) {
    return true;
  }
  const root = registeredCodexPlugin.root;
  if (root) {
    const entrypoint = resolveManagedCodexPackageEntrypoint(root);
    if (entrypoint && resolveManagedCodexNativeCommand(entrypoint)) {
      return true;
    }
  }
  if (resolveMacOSDesktopCodexAppServerCommandCandidates().some((command) => existsSync(command))) {
    return true;
  }
  const found = resolveNodeHostExecutable("codex", { strategy: "direct" })?.executable;
  return (
    found !== undefined && resolveInstalledCodexLauncher(found, process.platform) !== undefined
  );
}
