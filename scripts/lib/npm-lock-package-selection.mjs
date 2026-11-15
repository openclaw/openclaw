import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./record-shared.mjs";

const recordAt = (value, key) => {
  const nested = isRecord(value) ? value[key] : undefined;
  return isRecord(nested) ? nested : undefined;
};

/** @param {string} rootDir */
export function listManagedNpmLockPackageDirs(rootDir) {
  // npm locks are generated on demand for every publishable package, but never committed.
  return ["extensions", "packages"]
    .flatMap((parentDir) =>
      readdirSync(path.join(rootDir, parentDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.posix.join(parentDir, entry.name)),
    )
    .filter((packageDir) => {
      const packageJsonPath = path.join(rootDir, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return false;
      }
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return recordAt(recordAt(packageJson, "openclaw"), "release")?.publishToNpm === true;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

/** @param {readonly string[]} changedPaths @param {string} rootDir */
export function npmLockPackageDirsForChangedPaths(changedPaths, rootDir) {
  const packageDirs = new Set();
  const managedNpmLockPackageDirs = new Set(listManagedNpmLockPackageDirs(rootDir));

  for (const changedPath of changedPaths) {
    if (!changedPath) {
      continue;
    }
    if (changedPath === "package.json") {
      packageDirs.add(rootDir);
      continue;
    }
    const workspacePackageMatch = changedPath.match(
      /^((?:extensions|packages)\/[^/]+)(?:\/.*)?\/package\.json$/u,
    );
    const workspacePackageDir = workspacePackageMatch?.[1];
    if (workspacePackageDir && managedNpmLockPackageDirs.has(workspacePackageDir)) {
      packageDirs.add(path.resolve(rootDir, workspacePackageDir));
      continue;
    }
    if (
      changedPath === "pnpm-lock.yaml" ||
      changedPath === "pnpm-workspace.yaml" ||
      changedPath === "scripts/generate-npm-package-lock.mts" ||
      /^scripts\/lib\/(?:npm-lock-package-selection|record-shared)\.(?:mjs|d\.mts)$/u.test(
        changedPath,
      )
    ) {
      return [
        rootDir,
        ...listManagedNpmLockPackageDirs(rootDir).map((dir) => path.resolve(rootDir, dir)),
      ];
    }
  }

  const label = (dir) => path.relative(rootDir, dir).replaceAll(path.sep, "/") || ".";
  return [...packageDirs].toSorted((left, right) => label(left).localeCompare(label(right)));
}
