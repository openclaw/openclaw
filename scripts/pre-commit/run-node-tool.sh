#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

local_tool="$ROOT_DIR/node_modules/.bin/$tool"
# pnpm's sh shims resolve their target from POSIX-style $0 paths, which native
# Windows node cannot load. The .cmd shim is the native invocation on MSYS.
case "$(uname -s)" in
  CYGWIN*|MINGW*|MSYS*)
    if [[ -f "$local_tool.cmd" ]]; then
      exec "$local_tool.cmd" "$@"
    fi
    ;;
esac
if [[ -x "$local_tool" ]]; then
  exec "$local_tool" "$@"
fi

# Code-only worktrees can use the existing PR tooling owner without linking or
# installing dependencies. Keep stdin available for index-only formatting.
if [[ "$tool" == "oxfmt" && -f "$ROOT_DIR/package.json" ]]; then
  exec node --input-type=module -e '
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const [checkout, ...args] = process.argv.slice(1);
const gitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete gitEnv[key];
function git(root, args, missing = false) {
  const result = spawnSync(process.env.OPENCLAW_PR_GIT || "git", ["-C", root, ...args], {
    env: gitEnv, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (missing && result.status === 1) return "";
  if (result.status !== 0) throw new Error("Cannot resolve the repository tooling owner.");
  return result.stdout.trim();
}
function repository(url, root) {
  if (/^(?:\.?\.?\/|\/)/.test(url)) return realpathSync(resolve(root, url));
  const parsed = new URL(url.replace(/^git@([^:]+):/, "ssh://git@$1/"));
  if (parsed.protocol === "file:") return realpathSync(decodeURIComponent(parsed.pathname));
  return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "").toLowerCase()}`;
}
function contained(root, path) {
  const target = realpathSync(path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Formatter package escapes its tooling owner.");
  }
  return target;
}
try {
  const canonical = realpathSync(dirname(git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  const requested = process.env.OPENCLAW_PR_TOOLING_ROOT || git(canonical, ["config", "--path", "--get", "openclaw.pr.toolingRoot"], true);
  const root = realpathSync(resolve(canonical, requested || "."));
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root ||
      git(root, ["config", "--bool", "--get", "core.sparseCheckout"], true) === "true" ||
      repository(git(root, ["remote", "get-url", "origin"]), root) !== repository(git(canonical, ["remote", "get-url", "origin"]), canonical)) {
    throw new Error("Formatter tooling owner must be a full checkout of this repository.");
  }
  const taskManifest = readFileSync(join(checkout, "package.json"), "utf8");
  const required = JSON.parse(taskManifest).devDependencies?.oxfmt;
  const modules = contained(root, join(root, "node_modules"));
  const packagePath = contained(modules, join(modules, "oxfmt"));
  const manifestPath = join(packagePath, "package.json");
  const packageManifest = readFileSync(manifestPath, "utf8");
  const installed = JSON.parse(packageManifest);
  if (installed.name !== "oxfmt" || !required || installed.version !== required) {
    throw new Error(`Installed oxfmt does not match this checkout requirement: ${required ?? "undeclared"}.`);
  }
  const bin = contained(packagePath, join(packagePath, typeof installed.bin === "string" ? installed.bin : installed.bin.oxfmt));
  if (!statSync(bin).isFile()) throw new Error("Formatter executable is not a file.");
  const require = createRequire(manifestPath);
  for (const [name, version] of Object.entries(installed.dependencies ?? {})) {
    const dependencyPath = contained(modules, require.resolve(`${name}/package.json`));
    const dependency = JSON.parse(readFileSync(dependencyPath, "utf8"));
    contained(dirname(dependencyPath), require.resolve(name));
    if (dependency.name !== name || dependency.version !== version) {
      throw new Error("Formatter dependency does not match its declared version.");
    }
  }
  let platformFound = false;
  for (const [name, version] of Object.entries(installed.optionalDependencies ?? {})) {
    if (!name.startsWith("@oxfmt/binding-")) continue;
    let nativeManifest;
    try { nativeManifest = require.resolve(`${name}/package.json`); }
    catch (error) { if (error.code === "MODULE_NOT_FOUND") continue; throw error; }
    const native = JSON.parse(readFileSync(nativeManifest, "utf8"));
    if (!native.os?.includes(process.platform) || !native.cpu?.includes(process.arch)) continue;
    const nativeRoot = dirname(contained(modules, nativeManifest));
    const nativeEntry = contained(nativeRoot, join(nativeRoot, native.main));
    if (native.name !== name || native.version !== version || version !== required) {
      throw new Error("Formatter platform package does not match this checkout requirement.");
    }
    // Prove native loading, not a successful version from an unqualified WASI fallback.
    try { require(nativeEntry); platformFound = true; } catch {}
  }
  if (!platformFound) throw new Error("Missing formatter package for this platform.");
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH ||
      process.env.NAPI_RS_FORCE_WASI === "true" || process.env.NAPI_RS_FORCE_WASI === "error" ||
      process.env.NAPI_RS_WASI_FLAVOR) {
    throw new Error("Cannot qualify an overridden formatter platform binding.");
  }
  const env = { ...process.env, NAPI_RS_ENFORCE_VERSION_CHECK: "1" };
  const version = spawnSync(process.execPath, [bin, "--version"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (version.status !== 0 || version.stdout.trim() !== `Version: ${required}`) {
    throw new Error("Formatter could not verify its version on this platform.");
  }
  // Pin physical package paths and reject drift between admission and execution.
  if (readFileSync(join(checkout, "package.json"), "utf8") !== taskManifest ||
      readFileSync(manifestPath, "utf8") !== packageManifest ||
      realpathSync(join(modules, "oxfmt")) !== packagePath) {
    throw new Error("Formatter inputs changed during qualification; retry with a stable tooling owner.");
  }
  const result = spawnSync(process.execPath, [bin, ...args], { env, stdio: "inherit" });
  if (result.error || result.signal || result.status === null) throw new Error("Formatter did not complete.");
  process.exitCode = result.status;
} catch (error) {
  console.error(`[pre-commit] Cannot use tooling-owner oxfmt: ${error.message}`);
  console.error("Restore the selected tooling owner through its native dependency workflow; no dependencies were installed.");
  process.exitCode = 1;
}
' "$ROOT_DIR" "$@"
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  if [[ ! -e "$ROOT_DIR/node_modules" ]]; then
    echo "Missing repo dependencies: cannot run $tool without node_modules." >&2
    echo "Run pnpm install in a normal checkout, or bypass the hook only after separate formatting proof." >&2
    exit 1
  fi

  echo "Missing local tool: $local_tool" >&2
  exit 1
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
