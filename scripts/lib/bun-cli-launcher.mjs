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

const HEADER = "#!/bin/sh\n# OpenClaw Bun launcher\n";
const BODY = `bun= entry= records=0 malformed=
while IFS= read -r line; do
  case $line in
    '#openclaw-bun='*)
      [ "$records" -eq 0 ] || malformed=1
      bun=\${line#'#openclaw-bun='}
      records=1 ;;
    '#openclaw-entry='*)
      [ "$records" -eq 1 ] || malformed=1
      entry=\${line#'#openclaw-entry='}
      records=2 ;;
    *) [ "$records" -eq 0 ] || malformed=1 ;;
  esac
done < "$0"
if [ "$records" -ne 2 ] || [ -n "$malformed" ] || [ ! -x "$bun" ] || [ ! -f "$entry" ]; then
  printf 'openclaw: Bun launcher target not found (runtime: %s, entry: %s). Run "openclaw doctor" with Bun to repair.\\n' "$bun" "$entry" >&2
  exit 127
fi
exec "$bun" "$entry" "$@"
exit 127
`;

/** @param {{bunPath: string, entryPath: string}} target @returns {string | null} */
export function getBunCliLauncherPathIssue(target) {
  const unsupported = [
    ["\n", "a newline"],
    ["\r", "a carriage return"],
  ];
  for (const [label, value] of [
    ["Bun executable path", target.bunPath],
    ["Install path", target.entryPath],
  ]) {
    if (!isAbsolute(value) || value.includes("\0")) {
      return "Bun CLI launcher requires absolute, single-line runtime and entry paths";
    }
    for (const [character, name] of unsupported) {
      if (value.includes(character)) {
        return `${label} contains ${name}, which cannot be stored in a launcher data line`;
      }
    }
  }
  return null;
}

/** @param {{bunPath: string, entryPath: string}} target */
export function renderBunCliLauncher(target) {
  const issue = getBunCliLauncherPathIssue(target);
  if (issue) {
    throw new Error(issue);
  }
  // Released updaters rewrite raw prefixes, including an unknown final basename.
  // Only inert data follows the terminal exit; the shell never parses paths as code.
  return `${HEADER}${BODY}#openclaw-bun=${target.bunPath}\n#openclaw-entry=${target.entryPath}\n`;
}

/** @param {string} content */
export function parseBunCliLauncher(content) {
  if (!content.startsWith(HEADER)) {
    return null;
  }
  try {
    const match = /\n#openclaw-bun=([^\r\n]*)\n#openclaw-entry=([^\r\n]*)\n$/u.exec(content);
    if (!match) {
      return null;
    }
    const target = { bunPath: match[1], entryPath: match[2] };
    return renderBunCliLauncher(target) === content ? target : null;
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
