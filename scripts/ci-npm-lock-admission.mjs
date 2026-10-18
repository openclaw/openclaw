import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This is a conservative no-op proof, not a replacement for the lock generator's
// package selection. Unknown source contracts and Git failures retain execution.
export function canSkipNpmLockSetup({ cwd = process.cwd(), base = "", historical = false } = {}) {
  if (
    !base ||
    historical ||
    process.env.OPENCLAW_NPM_LOCK_JOBS !== undefined ||
    process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT !== undefined
  ) {
    return false;
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (
      manifest.scripts?.["deps:npm-lock:check:changed"] !==
      "node scripts/generate-npm-package-lock.mjs --changed"
    ) {
      return false;
    }
    // The harness can run against another revision. Never apply its no-op proof
    // to a different selector implementation, even if the command name matches.
    for (const file of [
      "scripts/generate-npm-package-lock.mjs",
      "scripts/generate-npm-package-lock.mts",
      "scripts/changed-lanes.mts",
      "scripts/lib/merge-head-diff-base.mjs",
    ]) {
      if (!readFileSync(path.join(cwd, file)).equals(readFileSync(path.join(harnessRoot, file)))) {
        return false;
      }
    }
    // The generator enumerates manifests even when no package is selected.
    // Preserve its failure path for an unreadable or malformed package inventory.
    for (const parent of ["extensions", "packages"]) {
      for (const entry of readdirSync(path.join(cwd, parent), { withFileTypes: true })) {
        const manifestPath = path.join(cwd, parent, entry.name, "package.json");
        if (entry.isDirectory() && existsSync(manifestPath)) {
          JSON.parse(readFileSync(manifestPath, "utf8"));
        }
      }
    }
    const git = (args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
    if (git(["rev-parse", "refs/remotes/origin/ci-ratchet-base^{commit}"]).trim() !== base) {
      return false;
    }
    // Match the generator: shallow CI checkouts may contain both endpoints but
    // no merge base. Only that explicit Git failure permits the two-dot fallback.
    // Disable rename detection so moving a manifest away cannot hide its old path.
    const diff = (range) => git(["diff", "--no-renames", "--name-only", "-z", range, "--"]);
    let rangePaths;
    try {
      rangePaths = diff(`${base}...HEAD`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("stderr" in error) ||
        !String(error.stderr).includes("no merge base")
      ) {
        return false;
      }
      rangePaths = diff(`${base}..HEAD`);
    }
    const paths = [
      rangePaths,
      git(["diff", "--no-renames", "--name-only", "-z", "--cached", "--"]),
      git(["diff", "--no-renames", "--name-only", "-z", "--"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]
      .join("\0")
      .split("\0")
      .filter(Boolean);
    return !paths.some(
      (file) =>
        /(^|\/)(package\.json|package-lock\.json)$/.test(file) ||
        /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/.test(file) ||
        /^(scripts|packages|\.github|patches)\//.test(file) ||
        file.endsWith(".tgz"),
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    `skip=${canSkipNpmLockSetup({
      base: process.env.CHECKOUT_BASE_SHA,
      historical: process.env.HISTORICAL_TARGET === "true",
    })}`,
  );
}
