import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  MANAGED_CODEX_APP_SERVER_PACKAGE,
  MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
} from "./version.js";

const OPENCLAW_CODEX_APP_SERVER_CACHE_DIR_ENV = "OPENCLAW_CODEX_APP_SERVER_CACHE_DIR";
const MANAGED_PACKAGE_SLUG = MANAGED_CODEX_APP_SERVER_PACKAGE.replace(/^@/, "").replace(
  /[\\/]/g,
  "-",
);
const managedInstallPromises = new Map<string, Promise<void>>();

type ManagedCodexAppServerPaths = {
  cacheDir: string;
  installRoot: string;
  commandPath: string;
};

export type ManagedCodexAppServerInstallParams = {
  installRoot: string;
  packageName: string;
  packageVersion: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

export type ResolveManagedCodexAppServerOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  installPackage?: (params: ManagedCodexAppServerInstallParams) => Promise<void>;
};

export async function resolveManagedCodexAppServerStartOptions(
  startOptions: CodexAppServerStartOptions,
  options: ResolveManagedCodexAppServerOptions = {},
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = resolveManagedCodexAppServerPaths({
    env,
    platform,
    homeDir: options.homeDir,
  });
  const pathExists = options.pathExists ?? commandPathExists;
  const installPackage = options.installPackage ?? installManagedCodexAppServerPackage;

  if (!(await pathExists(paths.commandPath, platform))) {
    await ensureManagedCodexAppServerPackageInstalled(paths, {
      env,
      platform,
      installPackage,
      pathExists,
    });
  }

  return {
    ...startOptions,
    command: paths.commandPath,
    commandSource: "resolved-managed",
  };
}

export function resolveManagedCodexAppServerPaths(params: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): ManagedCodexAppServerPaths {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const cacheDir =
    readNonEmptyString(env[OPENCLAW_CODEX_APP_SERVER_CACHE_DIR_ENV]) ??
    defaultOpenClawCacheDir({ env, platform, homeDir: params.homeDir });
  const installRoot = path.join(
    cacheDir,
    "codex-app-server",
    `${MANAGED_PACKAGE_SLUG}-${MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION}`,
  );
  const commandPath = path.join(
    installRoot,
    "node_modules",
    ".bin",
    platform === "win32" ? "codex.cmd" : "codex",
  );
  return { cacheDir, installRoot, commandPath };
}

async function ensureManagedCodexAppServerPackageInstalled(
  paths: ManagedCodexAppServerPaths,
  runtime: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    installPackage: (params: ManagedCodexAppServerInstallParams) => Promise<void>;
    pathExists: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  },
): Promise<void> {
  let installPromise = managedInstallPromises.get(paths.installRoot);
  if (!installPromise) {
    installPromise = (async () => {
      await mkdir(paths.installRoot, { recursive: true });
      await runtime.installPackage({
        installRoot: paths.installRoot,
        packageName: MANAGED_CODEX_APP_SERVER_PACKAGE,
        packageVersion: MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
        env: runtime.env,
        platform: runtime.platform,
      });
    })();
    managedInstallPromises.set(paths.installRoot, installPromise);
  }

  try {
    await installPromise;
  } catch (error) {
    if (managedInstallPromises.get(paths.installRoot) === installPromise) {
      managedInstallPromises.delete(paths.installRoot);
    }
    throw managedInstallError(error);
  }

  if (!(await runtime.pathExists(paths.commandPath, runtime.platform))) {
    if (managedInstallPromises.get(paths.installRoot) === installPromise) {
      managedInstallPromises.delete(paths.installRoot);
    }
    throw new Error(
      `Managed Codex app-server binary was not created at ${paths.commandPath}. Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary.`,
    );
  }
}

async function installManagedCodexAppServerPackage(
  params: ManagedCodexAppServerInstallParams,
): Promise<void> {
  const npmCommand = params.platform === "win32" ? "npm.cmd" : "npm";
  const packageSpecifier = `${params.packageName}@${params.packageVersion}`;
  const npmArgs = [
    "install",
    "--prefix",
    params.installRoot,
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    packageSpecifier,
  ];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(npmCommand, npmArgs, {
      env: params.env,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };
    child.once("error", (error) =>
      settle(() => reject(new Error(`npm install failed to start: ${error.message}`))),
    );
    child.once("exit", (code, signal) =>
      settle(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `npm install exited with code ${formatExitValue(code)} and signal ${formatExitValue(signal)}`,
          ),
        );
      }),
    );
  });
}

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultOpenClawCacheDir(params: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir?: string;
}): string {
  const xdgCacheHome = readNonEmptyString(params.env.XDG_CACHE_HOME);
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "openclaw");
  }
  if (params.platform === "win32") {
    const localAppData = readNonEmptyString(params.env.LOCALAPPDATA);
    if (localAppData) {
      return path.join(localAppData, "OpenClaw", "Cache");
    }
  }
  return path.join(params.homeDir ?? os.homedir(), ".cache", "openclaw");
}

function managedInstallError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `OpenClaw could not install the managed Codex app-server binary (${MANAGED_CODEX_APP_SERVER_PACKAGE}@${MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION}): ${message}. Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary.`,
  );
}

function formatExitValue(value: number | string | null): string {
  return value === null ? "null" : String(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
