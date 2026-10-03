/**
 * Resolves the managed Codex app-server binary shipped with or installed beside
 * the Codex plugin before stdio startup.
 */
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { valid } from "semver";
import type { CodexAppServerStartOptions, CodexManagedCommandOrder } from "./config.js";
import {
  resolveMacOSDesktopCodexAppPathCandidatesForCommand,
  resolveMacOSDesktopCodexAppServerCommandCandidates,
  resolveSelectedMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import {
  readCodexManagedRuntimeSelection,
  resolveCodexManagedRuntimeRoot,
  isCodexManagedRuntimeAppPath,
  type CodexManagedRuntimeStateOptions,
} from "./managed-runtime-installation.js";
import { CODEX_APP_SERVER_VERSION, MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

// Registration and lazy runtime artifacts can load separate module copies.
// They must resolve dependencies from the same loader-owned plugin root.
const registeredCodexPlugin = resolveGlobalSingleton<{ root?: string }>(
  Symbol.for("openclaw.codexManagedPluginRoot"),
  () => ({}),
);

type ResolveManagedCodexAppServerOptions = CodexManagedRuntimeStateOptions & {
  managedRoot?: string;
  managedCliRoot?: string;
  /** Supplied only by the lifecycle generation acquired for this startup. */
  desktopCandidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
};

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

/** Rewrites managed stdio start options to point at an executable Codex binary path. */
export async function resolveManagedCodexAppServerStartOptions(
  startOptions: CodexAppServerStartOptions,
  options: ResolveManagedCodexAppServerOptions = {},
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }

  const pluginRoot = options.pluginRoot ?? registeredCodexPlugin.root;
  if (!pluginRoot) {
    throw new Error(
      "Codex plugin root is unavailable. Load the Codex plugin before starting its managed app-server.",
    );
  }
  const platform = options.platform ?? process.platform;
  const candidateCommandPaths = await resolveManagedCodexAppServerCommandCandidates(
    pluginRoot,
    platform,
    startOptions.managedCommandOrder ?? "package-first",
    options,
  );
  const pathExists = options.pathExists ?? commandPathExists;
  const commandPaths: string[] = [];
  for (const commandPath of candidateCommandPaths) {
    if (await pathExists(commandPath, platform)) {
      commandPaths.push(commandPath);
    }
  }
  const [commandPath, ...managedFallbackCommandPaths] = commandPaths;
  if (commandPath === undefined) {
    throw new Error(
      [
        `Managed Codex app-server binary was not found for ${MANAGED_CODEX_APP_SERVER_PACKAGE}.`,
        "Reinstall or update OpenClaw, or run pnpm install in a source checkout.",
        "Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary.",
      ].join(" "),
    );
  }

  return {
    ...startOptions,
    command: commandPath,
    commandSource: "resolved-managed",
    ...(managedFallbackCommandPaths.length > 0 ? { managedFallbackCommandPaths } : {}),
  };
}

/** Resolves the native artifact behind a successful managed launcher selection. */
export function resolveManagedCodexNativeCommand(
  command: string,
  options: ResolveManagedCodexNativeCommandOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (isManagedCodexDesktopCommand(command, platform)) {
    return command;
  }
  const target = resolveCodexNativeTarget(platform, options.arch ?? process.arch);
  if (!target) {
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
    resolvePackageJson(target.packageName, packageRoot) ??
    resolvePackageJson(MANAGED_CODEX_APP_SERVER_PACKAGE, packageRoot);
  if (!packageJsonPath) {
    return undefined;
  }
  const candidate = path.join(
    path.dirname(packageJsonPath),
    "vendor",
    target.triple,
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

/** Doctor checks a retained generation against its own manifest, not the bootstrap pin. */
export async function readManagedCodexExpectedVersion(command: string): Promise<string> {
  const packageRoot = resolveManagedCodexPackageRootForCommand(command, process.platform);
  if (
    !packageRoot ||
    !isCodexManagedRuntimeAppPath(packageRoot, resolveCodexManagedRuntimeRoot("cli"))
  ) {
    return CODEX_APP_SERVER_VERSION;
  }
  const { readJsonFileWithFallback } = await import("openclaw/plugin-sdk/json-store");
  const { value } = await readJsonFileWithFallback<unknown>(
    path.join(packageRoot, "package.json"),
    undefined,
  );
  if (
    !isRecord(value) ||
    value.name !== MANAGED_CODEX_APP_SERVER_PACKAGE ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.version) ||
    !valid(value.version)
  ) {
    throw new Error(
      "invalid managed Codex package manifest; restore or replace the retained runtime before retrying",
    );
  }
  return value.version;
}

/** Returns whether a command is one of the standard macOS desktop app executables. */
export function isManagedCodexDesktopCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (resolveMacOSDesktopCodexAppServerCommandCandidates(platform).includes(command)) {
    return true;
  }
  return Boolean(
    resolveMacOSDesktopCodexAppPathCandidatesForCommand(command, platform).exactDesktopCandidate,
  );
}

function resolveManagedCodexPackageRootForCommand(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const managedPackageRoot = path.dirname(path.dirname(command));
  if (
    path.basename(command) === "codex.js" &&
    isCodexManagedRuntimeAppPath(managedPackageRoot, resolveCodexManagedRuntimeRoot("cli"))
  ) {
    return managedPackageRoot;
  }
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

function resolveCodexNativeTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): { packageName: string; triple: string } | undefined {
  // Mirrors @openai/codex's launcher mapping; this resolves identity only and
  // leaves process environment/launch behavior with the upstream entrypoint.
  if ((platform === "linux" || platform === "android") && arch === "x64") {
    return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  if ((platform === "linux" || platform === "android") && arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (platform === "win32" && arch === "x64") {
    return { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
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

async function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
  managedCommandOrder: CodexManagedCommandOrder,
  options: ResolveManagedCodexAppServerOptions,
): Promise<string[]> {
  const packageCommand = resolveManagedCodexPackageEntrypoint(pluginRoot);
  const selected = await readCodexManagedRuntimeSelection(
    options.managedCliRoot ?? resolveCodexManagedRuntimeRoot("cli"),
    options,
  );
  const packageCommandPaths = [
    ...(selected?.selection.appName === "cli"
      ? [path.join(selected.appBundlePath, "bin", "codex.js")]
      : []),
    ...(packageCommand ? [packageCommand] : []),
  ];
  if (managedCommandOrder === "package-only") {
    return packageCommandPaths;
  }
  const desktopCommandPaths = (
    options.desktopCandidates ??
    (await resolveSelectedMacOSDesktopCodexAppPathCandidates(
      platform,
      options.managedRoot,
      options,
    ))
  ).map((candidate) => candidate.appServerCommandPath);
  // The packaged version is a bootstrap fallback. Computer Use opts
  // into the desktop app owner because its macOS TCC permissions live there.
  return managedCommandOrder === "desktop-first"
    ? [...desktopCommandPaths, ...packageCommandPaths]
    : [...packageCommandPaths, ...desktopCommandPaths];
}

export function resolveManagedCodexPackageEntrypoint(pluginRoot: string): string | undefined {
  const require = createRequire(path.join(pluginRoot, "package.json"));
  // Only the plugin's dependency ancestry owns its bootstrap runtime. Bare
  // resolution also searches NODE_PATH and user-global packages, which can
  // silently substitute an unrelated runtime when the managed package is absent.
  for (let owner = path.resolve(pluginRoot); ; owner = path.dirname(owner)) {
    if (path.basename(owner) !== "node_modules") {
      try {
        // Resolve links through Node so pnpm's external store remains supported.
        return require.resolve(
          path.join(owner, "node_modules", MANAGED_CODEX_APP_SERVER_PACKAGE, "bin", "codex.js"),
        );
      } catch {
        // A hoisted dependency can belong to the next enclosing install owner.
      }
    }
    if (path.dirname(owner) === owner) {
      return undefined;
    }
  }
}

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Preserves the fallback tail for each concrete managed spawn attempt. */
export function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (const [index, command] of commands.entries()) {
    const managedFallbackCommandPaths = commands.slice(index + 1);
    const candidate = {
      ...startOptions,
      command,
    };
    if (managedFallbackCommandPaths.length === 0) {
      delete candidate.managedFallbackCommandPaths;
    } else {
      candidate.managedFallbackCommandPaths = managedFallbackCommandPaths;
    }
    candidates.push(candidate);
  }
  return candidates;
}
