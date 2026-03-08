import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";

const execFile = promisify(nodeExecFile);

export type ParsedLocalAotuiSource = {
  kind: "local";
  source: string;
  absolutePath: string;
};

export type ParsedNpmAotuiSource = {
  kind: "npm";
  source: string;
  packageName: string;
  version: string | null;
  packageSpec: string;
};

export type ParsedAotuiInstallSource = ParsedLocalAotuiSource | ParsedNpmAotuiSource;

export type AotuiNpmInstallOptions = {
  cacheRoot?: string;
  forceReinstall?: boolean;
  npmBinary?: string;
  commandRunner?: (command: string, args: string[], cwd: string) => Promise<void>;
};

export type AotuiNpmInstallResult = {
  packageName: string;
  packageSpec: string;
  requestedVersion: string | null;
  resolvedVersion: string | null;
  installRoot: string;
  installedPath: string;
  localSource: string;
};

export function resolveManagedAotuiAppCacheRoot(): string {
  return path.join(resolveStateDir(), "agent-apps", "npm");
}

export function parseAotuiInstallSource(
  input: string,
  cwd = process.cwd(),
): ParsedAotuiInstallSource {
  const value = input.trim();
  if (!value) {
    throw new Error("Install source is required");
  }
  if (value.startsWith("git:")) {
    throw new Error("git source is not supported yet. Use an npm package or local path.");
  }
  if (value.startsWith("local:")) {
    return parseLocalSource(value.slice("local:".length), cwd);
  }
  if (value.startsWith("file://")) {
    const absolutePath = fileUrlToPath(value);
    return {
      kind: "local",
      source: `local:${absolutePath}`,
      absolutePath,
    };
  }
  if (value.startsWith("npm:")) {
    const npm = parseNpmSpecifier(value.slice("npm:".length));
    return {
      kind: "npm",
      source: `npm:${npm.packageSpec}`,
      packageName: npm.packageName,
      version: npm.version,
      packageSpec: npm.packageSpec,
    };
  }
  if (looksLikeLocalPath(value)) {
    return parseLocalSource(value, cwd);
  }
  const npm = parseNpmSpecifier(value);
  return {
    kind: "npm",
    source: `npm:${npm.packageSpec}`,
    packageName: npm.packageName,
    version: npm.version,
    packageSpec: npm.packageSpec,
  };
}

export function parseNpmSpecifier(raw: string): {
  packageName: string;
  version: string | null;
  packageSpec: string;
} {
  const spec = raw.trim();
  if (!spec) {
    throw new Error("npm package spec cannot be empty");
  }

  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex <= 1) {
      throw new Error(`Invalid scoped npm package spec: ${raw}`);
    }
    const atAfterScope = spec.lastIndexOf("@");
    if (atAfterScope > slashIndex) {
      const packageName = spec.slice(0, atAfterScope);
      const version = spec.slice(atAfterScope + 1);
      validatePackageName(packageName, raw);
      return {
        packageName,
        version: version || null,
        packageSpec: version ? `${packageName}@${version}` : packageName,
      };
    }
    validatePackageName(spec, raw);
    return {
      packageName: spec,
      version: null,
      packageSpec: spec,
    };
  }

  const atIndex = spec.lastIndexOf("@");
  if (atIndex > 0) {
    const packageName = spec.slice(0, atIndex);
    const version = spec.slice(atIndex + 1);
    validatePackageName(packageName, raw);
    return {
      packageName,
      version: version || null,
      packageSpec: version ? `${packageName}@${version}` : packageName,
    };
  }

  validatePackageName(spec, raw);
  return {
    packageName: spec,
    version: null,
    packageSpec: spec,
  };
}

export function looksLikeLocalPath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return true;
  }
  if (value.startsWith("file://")) {
    return true;
  }
  if (value.startsWith("@")) {
    return false;
  }
  return fs.existsSync(value);
}

export async function installNpmAotuiPackage(
  packageInput: string,
  options?: AotuiNpmInstallOptions,
): Promise<AotuiNpmInstallResult> {
  const parsed = parseNpmSpecifier(packageInput);
  const cacheRoot = options?.cacheRoot ?? resolveManagedAotuiAppCacheRoot();
  const npmBinary = options?.npmBinary ?? "npm";
  const requestedVersion = parsed.version;
  const versionSegment = sanitizeSegment(parsed.version ?? "latest");
  const packageSegment = sanitizePackageName(parsed.packageName);
  const installRoot = path.join(cacheRoot, packageSegment, versionSegment);
  await fsp.mkdir(installRoot, { recursive: true });
  await ensureInstallWorkspace(installRoot);

  const installedPath = path.join(installRoot, "node_modules", parsed.packageName);
  const alreadyInstalled = fs.existsSync(installedPath);
  if (!alreadyInstalled || options?.forceReinstall) {
    await runInstallCommand(
      npmBinary,
      ["install", "--no-save", "--omit=dev", "--ignore-scripts", parsed.packageSpec],
      installRoot,
      options?.commandRunner,
    );
  }

  if (!fs.existsSync(installedPath)) {
    throw new Error(`Package install succeeded but app path was not found: ${installedPath}`);
  }

  const resolvedVersion = await readPackageVersion(installedPath);
  return {
    packageName: parsed.packageName,
    packageSpec: parsed.packageSpec,
    requestedVersion,
    resolvedVersion,
    installRoot,
    installedPath,
    localSource: `local:${installedPath}`,
  };
}

export async function cleanupManagedAotuiAppArtifacts(source: string): Promise<boolean> {
  if (!source.startsWith("local:")) {
    return false;
  }

  const managedRoot = path.resolve(resolveManagedAotuiAppCacheRoot());
  const installedPath = path.resolve(source.slice("local:".length));
  if (!installedPath.startsWith(`${managedRoot}${path.sep}`)) {
    return false;
  }

  const installRoot = resolveManagedInstallRoot(installedPath);
  if (!installRoot || !installRoot.startsWith(`${managedRoot}${path.sep}`)) {
    return false;
  }

  await fsp.rm(installRoot, { recursive: true, force: true });
  await pruneEmptyParentDirs(path.dirname(installRoot), managedRoot);
  return true;
}

export function deriveAotuiRegistryName(params: {
  parsedSource: ParsedAotuiInstallSource;
  alias?: string;
}): string {
  const alias = params.alias?.trim();
  if (alias) {
    return alias;
  }

  if (params.parsedSource.kind === "npm") {
    const packageName = params.parsedSource.packageName;
    const slash = packageName.lastIndexOf("/");
    return (slash >= 0 ? packageName.slice(slash + 1) : packageName).trim();
  }

  return path.basename(params.parsedSource.absolutePath).trim();
}

function parseLocalSource(localPathInput: string, cwd: string): ParsedLocalAotuiSource {
  const expanded = expandHomePath(localPathInput.trim());
  const absolutePath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return {
    kind: "local",
    source: `local:${absolutePath}`,
    absolutePath,
  };
}

function expandHomePath(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

function fileUrlToPath(fileUrl: string): string {
  return fileURLToPath(fileUrl);
}

function validatePackageName(name: string, raw: string): void {
  const npmNamePattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  if (!npmNamePattern.test(name)) {
    throw new Error(`Invalid npm package name in spec "${raw}"`);
  }
}

function sanitizePackageName(value: string): string {
  return value
    .replace(/^@/, "scope-")
    .replace(/[\\/]/g, "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function ensureInstallWorkspace(workspaceRoot: string): Promise<void> {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    return;
  }
  await fsp.writeFile(
    packageJsonPath,
    JSON.stringify(
      {
        name: "openclaw-agent-app-cache",
        private: true,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function runInstallCommand(
  command: string,
  args: string[],
  cwd: string,
  commandRunner?: (command: string, args: string[], cwd: string) => Promise<void>,
): Promise<void> {
  if (commandRunner) {
    await commandRunner(command, args, cwd);
    return;
  }
  try {
    await execFile(command, args, { cwd });
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : "";
    const reason = stderr ? `: ${stderr}` : "";
    throw new Error(`Failed to install npm package with "${command} ${args.join(" ")}"${reason}`, {
      cause: error,
    });
  }
}

async function readPackageVersion(installedPath: string): Promise<string | null> {
  const packageJsonPath = path.join(installedPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const raw = await fsp.readFile(packageJsonPath, "utf-8");
    const json = JSON.parse(raw) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

function resolveManagedInstallRoot(installedPath: string): string | null {
  const segments = path.normalize(installedPath).split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex > 0) {
    return segments.slice(0, nodeModulesIndex).join(path.sep) || path.sep;
  }
  return null;
}

async function pruneEmptyParentDirs(startDir: string, stopDir: string): Promise<void> {
  let current = path.resolve(startDir);
  const normalizedStop = path.resolve(stopDir);
  while (current.startsWith(`${normalizedStop}${path.sep}`)) {
    try {
      const entries = await fsp.readdir(current);
      if (entries.length > 0) {
        break;
      }
      await fsp.rmdir(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}
