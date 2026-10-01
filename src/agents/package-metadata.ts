/** Package metadata and assets without runtime configuration dependencies. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
declare const WORKER_DEPLOY_VERSION: string | undefined;

/** Bun compiled binaries use virtual filesystem URLs. */
export const isBunBinary =
  import.meta.url.includes("$bunfs") ||
  import.meta.url.includes("~BUN") ||
  import.meta.url.includes("%7EBUN");

function getPackageDir(): string {
  // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
  const envDir = process.env.OPENCLAW_PACKAGE_DIR;
  if (envDir) {
    if (envDir === "~") {
      return homedir();
    }
    if (envDir.startsWith("~/")) {
      return homedir() + envDir.slice(1);
    }
    return envDir;
  }

  if (isBunBinary) {
    return dirname(process.execPath);
  }
  let dir = currentDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return currentDir;
}

export function getReadmePath(): string {
  return resolve(join(getPackageDir(), "README.md"));
}

export function getDocsPath(): string {
  return resolve(join(getPackageDir(), "docs"));
}

export function getExamplesPath(): string {
  return resolve(join(getPackageDir(), "examples"));
}

interface PackageJson {
  name?: string;
  version?: string;
  openclawConfig?: {
    name?: string;
    configDir?: string;
  };
}

const workerVersion = typeof WORKER_DEPLOY_VERSION === "string" ? WORKER_DEPLOY_VERSION : undefined;
const pkg: PackageJson = workerVersion
  ? { name: "openclaw", version: workerVersion }
  : (JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf-8")) as PackageJson); // SAFETY: The package owns this metadata contract.

export const APP_NAME: string = pkg.openclawConfig?.name || "openclaw";
export const CONFIG_DIR_NAME: string = pkg.openclawConfig?.configDir || ".openclaw";
export const PACKAGE_MANIFEST_VERSION: string = pkg.version || "0.0.0";
