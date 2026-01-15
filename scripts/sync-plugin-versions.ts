import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
};

const root = resolve(".");
const rootPackagePath = resolve("package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
const targetVersion = rootPackage.version;

if (!targetVersion) {
  throw new Error("Root package.json missing version.");
}

const extensionsDir = resolve("extensions");
const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

const updated: string[] = [];
const skipped: string[] = [];

for (const dir of dirs) {
  const packagePath = join(extensionsDir, dir.name, "package.json");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
  } catch {
    continue;
  }

  if (!pkg.name) {
    skipped.push(dir.name);
    continue;
  }

  if (pkg.version === targetVersion) {
    skipped.push(pkg.name);
    continue;
  }

  pkg.version = targetVersion;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  updated.push(pkg.name);
}

console.log(
  `Synced plugin versions to ${targetVersion}. Updated: ${updated.length}. Skipped: ${skipped.length}.`
);
