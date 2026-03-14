import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function isUsableExecutable(candidate) {
  if (!candidate) {
    return false;
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(pathEnv = process.env.PATH ?? "") {
  return pathEnv.split(path.delimiter).filter(Boolean);
}

export function preferredWindowsShells(params = {}) {
  const platform = params.platform ?? process.platform;
  const systemDrive = params.systemDrive ?? process.env.SystemDrive;
  if (platform !== "win32") {
    return [];
  }

  const candidates = [];
  const driveRoots = new Set([systemDrive ? `${systemDrive}\\` : null, "C:\\"]);

  for (const root of driveRoots) {
    if (!root) {
      continue;
    }
    candidates.push(path.join(root, "msys64", "usr", "bin", "bash.exe"));
    candidates.push(path.join(root, "msys64", "usr", "bin", "sh.exe"));
    candidates.push(path.join(root, "Program Files", "Git", "bin", "bash.exe"));
    candidates.push(path.join(root, "Program Files", "Git", "usr", "bin", "bash.exe"));
    candidates.push(path.join(root, "Program Files", "Git", "usr", "bin", "sh.exe"));
  }

  return candidates;
}

export function buildShellPath(params = {}) {
  const platform = params.platform ?? process.platform;
  const execPath = params.execPath ?? process.execPath;
  const appData = params.appData ?? process.env.APPDATA;
  const pathEnv = params.pathEnv ?? process.env.PATH ?? "";
  const nodeBinDir = path.dirname(execPath);
  const roamingNpmBin = platform === "win32" && appData ? path.join(appData, "npm") : null;
  return [roamingNpmBin, nodeBinDir, pathEnv].filter(Boolean).join(path.delimiter);
}

export function resolvePosixShell(params = {}) {
  const platform = params.platform ?? process.platform;
  const candidates = [];

  for (const candidate of params.preferredCandidates ?? preferredWindowsShells(params)) {
    candidates.push(candidate);
  }

  const entries = pathEntries(params.pathEnv);
  const seen = new Set();
  for (const entry of entries) {
    const normalized = path.normalize(entry).toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (platform === "win32") {
      if (
        normalized.includes(`${path.sep}windows${path.sep}system32`) ||
        normalized.includes(`${path.sep}windowsapps`) ||
        normalized.includes(`${path.sep}cygwin`)
      ) {
        continue;
      }
    }

    candidates.push(path.join(entry, "sh.exe"));
    candidates.push(path.join(entry, "bash.exe"));
    candidates.push(path.join(entry, "sh"));
    candidates.push(path.join(entry, "bash"));
  }

  return candidates.find(isUsableExecutable);
}

export function main(argv = process.argv.slice(2)) {
  const shell = resolvePosixShell();
  if (!shell) {
    console.error("Unable to find a usable POSIX shell on PATH.");
    console.error("Install Git Bash, MSYS2, or Cygwin and retry.");
    return 1;
  }

  const scriptPath = argv[0];
  if (!scriptPath) {
    console.error("Usage: node scripts/run-bash.mjs <script> [args...]");
    return 1;
  }

  const args = [scriptPath, ...argv.slice(1)];
  const result = spawnSync(shell, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: buildShellPath(),
    },
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
