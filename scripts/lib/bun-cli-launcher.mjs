import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const HEADER = "#!/bin/sh\n# OpenClaw Bun launcher ";

/** @param {string} value */
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {{bunPath: string, entryPath: string}} target */
export function renderBunCliLauncher(target) {
  for (const value of [target.bunPath, target.entryPath]) {
    if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) {
      throw new Error("Bun CLI launcher requires absolute, single-line runtime and entry paths");
    }
  }
  // The comment lets staging relocate paths structurally, before shell quoting.
  return `${HEADER}${JSON.stringify(target)}\nexec ${quote(target.bunPath)} ${quote(target.entryPath)} "$@"\n`;
}

/** @param {string} content */
export function parseBunCliLauncher(content) {
  if (!content.startsWith(HEADER)) {
    return null;
  }
  try {
    const target = JSON.parse(content.slice(HEADER.length).split("\n")[0]);
    if (
      typeof target?.bunPath !== "string" ||
      typeof target?.entryPath !== "string" ||
      renderBunCliLauncher({ bunPath: target.bunPath, entryPath: target.entryPath }) !== content
    ) {
      return null;
    }
    return { bunPath: target.bunPath, entryPath: target.entryPath };
  } catch {
    return null;
  }
}

/** @param {{bunPath: string, env?: NodeJS.ProcessEnv, cwd?: string}} params */
export function resolveBunGlobalBinDir(params) {
  if (!isAbsolute(params.bunPath)) {
    throw new Error("Bun CLI launcher requires an absolute Bun executable");
  }
  const result = spawnSync(params.bunPath, ["pm", "bin", "-g"], {
    cwd: params.cwd,
    env: params.env ?? process.env,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const binDir = result.stdout?.trim();
  if (
    result.error ||
    result.status !== 0 ||
    !binDir ||
    !isAbsolute(binDir) ||
    /[\r\n]/u.test(binDir)
  ) {
    throw new Error("Could not resolve the owning Bun global bin directory with bun pm bin -g");
  }
  return binDir;
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  if (resolve(left) === resolve(right)) {
    return true;
  }
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** @param {{packageRoot: string, bunPath: string, binDir: string}} params */
export function inspectBunCliLauncher(params) {
  const target = { bunPath: params.bunPath, entryPath: join(params.packageRoot, "openclaw.mjs") };
  const content = renderBunCliLauncher(target);
  const path = join(params.binDir, "openclaw");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { path, state: "missing" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { path, state: samePath(path, target.entryPath) ? "stale" : "conflict" };
  }
  if (!stat.isFile()) {
    return { path, state: "conflict" };
  }
  const existing = readFileSync(path, "utf8");
  const recorded = parseBunCliLauncher(existing);
  if (!recorded || !samePath(recorded.entryPath, target.entryPath)) {
    return { path, state: "conflict" };
  }
  return {
    path,
    state: existing === content && (stat.mode & 0o111) === 0o111 ? "current" : "stale",
  };
}

/** Caller owns the selected package/bin pair; never follows the bin symlink when writing.
 * @param {{packageRoot: string, bunPath: string, binDir: string}} params
 */
export function installBunCliLauncher(params) {
  const inspected = inspectBunCliLauncher(params);
  if (inspected.state === "conflict") {
    throw new Error(
      `Bun CLI launcher ${inspected.path} belongs to another command; left unchanged`,
    );
  }
  if (inspected.state === "current") {
    return inspected;
  }
  const content = renderBunCliLauncher({
    bunPath: params.bunPath,
    entryPath: join(params.packageRoot, "openclaw.mjs"),
  });
  mkdirSync(params.binDir, { recursive: true });
  const temporary = mkdtempSync(join(params.binDir, ".openclaw-launcher-"));
  try {
    const file = join(temporary, "openclaw");
    writeFileSync(file, content, { mode: 0o755, flag: "wx" });
    chmodSync(file, 0o755);
    // Recheck ownership after preparing the replacement, including Doctor consent.
    if (inspectBunCliLauncher(params).state === "conflict") {
      throw new Error(`Bun CLI launcher ${inspected.path} changed; left unchanged`);
    }
    renameSync(file, inspected.path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { path: inspected.path, state: "current" };
}
