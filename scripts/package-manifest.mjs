#!/usr/bin/env node

// Temporarily prepares source-only package metadata for publishing.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_PATH = "package.json";
const BACKUP_PATH = path.join(".artifacts", "package-manifest", "package.json.prepack-backup");
// Source checkouts use TS tooling; production installs omit dev dependencies.
// Rewrite only during prepack so published commands load the bundled runtime.
const CRABBOX_SOURCE_LAUNCHER = "node scripts/crabbox-wrapper.mjs";
const CRABBOX_PUBLISHED_LAUNCHER = "node dist/crabbox-wrapper.js";
const RUNTIME_RECEIPT_KIND = "openclaw-runtime-package-manifest-v1";

function runtimeExportConditions(value) {
  if (Array.isArray(value)) {
    return value.map(runtimeExportConditions);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([condition]) => condition !== "types" && !condition.startsWith("types@"))
        .map(([condition, target]) => [condition, runtimeExportConditions(target)]),
    );
  }
  return value;
}

function preparedPackageManifest(content, runtimeOnly = false) {
  const packageJson = JSON.parse(content);
  let changed = false;

  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (
      typeof command === "string" &&
      (command === CRABBOX_SOURCE_LAUNCHER || command.startsWith(`${CRABBOX_SOURCE_LAUNCHER} `))
    ) {
      packageJson.scripts[name] =
        `${CRABBOX_PUBLISHED_LAUNCHER}${command.slice(CRABBOX_SOURCE_LAUNCHER.length)}`;
      changed = true;
    }
  }

  const devDependencies = packageJson.devDependencies;
  if (devDependencies && typeof devDependencies === "object" && !Array.isArray(devDependencies)) {
    const devDependencyEntries = Object.entries(devDependencies);
    const publishedDevDependencyEntries = devDependencyEntries.filter(
      ([, spec]) => typeof spec !== "string" || !spec.startsWith("workspace:"),
    );
    if (publishedDevDependencyEntries.length !== devDependencyEntries.length) {
      changed = true;
      if (publishedDevDependencyEntries.length === 0) {
        delete packageJson.devDependencies;
      } else {
        packageJson.devDependencies = Object.fromEntries(publishedDevDependencyEntries);
      }
    }
  }
  if (runtimeOnly) {
    // Private app installation artifacts are not the published typed SDK.
    // Keep runtime resolution intact without advertising declarations we did not build.
    packageJson.private = true;
    delete packageJson.types;
    delete packageJson.typings;
    delete packageJson.typesVersions;
    if (packageJson.exports) {
      packageJson.exports = runtimeExportConditions(packageJson.exports);
    }
    changed = true;
  }
  return changed ? `${JSON.stringify(packageJson, null, 2)}\n` : content;
}

/** Restore package.json after prepack prepared it for publishing. */
export async function restorePackageManifest(cwd = process.cwd()) {
  const backupPath = path.join(cwd, BACKUP_PATH);
  if (!existsSync(backupPath)) {
    return false;
  }
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const [backup, current] = await Promise.all([
    readFile(backupPath, "utf8"),
    readFile(packageJsonPath, "utf8"),
  ]);
  const receipt = JSON.parse(backup);
  const runtimeOnly = receipt.kind === RUNTIME_RECEIPT_KIND;
  if (
    runtimeOnly &&
    (typeof receipt.original !== "string" ||
      typeof receipt.prepared !== "string" ||
      receipt.prepared !== preparedPackageManifest(receipt.original, true))
  ) {
    throw new Error("Invalid runtime package manifest preparation receipt.");
  }
  const original = runtimeOnly ? receipt.original : backup;
  const prepared = runtimeOnly ? receipt.prepared : preparedPackageManifest(original);
  if (current !== original && current !== prepared) {
    throw new Error(
      `Refusing to restore ${PACKAGE_JSON_PATH} because it changed after prepack sanitized it.`,
    );
  }
  await writeFile(packageJsonPath, original, "utf8");
  await rm(backupPath, { force: true });
  return true;
}

/** Prepare published package metadata while recording restorable source bytes. */
export async function preparePackageManifest(cwd = process.cwd()) {
  return prepareManifest(cwd, false);
}

/** Prepare an unpublished private runtime artifact, including bundled workspace packages. */
export async function prepareRuntimePackageManifest(cwd = process.cwd()) {
  return prepareManifest(cwd, true);
}

async function prepareManifest(cwd, runtimeOnly) {
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const backupPath = path.join(cwd, BACKUP_PATH);
  const original = await readFile(packageJsonPath, "utf8");
  const prepared = preparedPackageManifest(original, runtimeOnly);
  if (prepared === original) {
    return false;
  }
  await mkdir(path.dirname(backupPath), { recursive: true });
  try {
    // Pin the mode and exact prepared bytes to this owner. Normal preparation
    // must never authorize restoring an unrelated runtime-only rewrite.
    const backup = runtimeOnly
      ? JSON.stringify({ kind: RUNTIME_RECEIPT_KIND, original, prepared })
      : original;
    await writeFile(backupPath, backup, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Another package preparation owns ${PACKAGE_JSON_PATH}; wait for it to finish or run \`node scripts/openclaw-postpack.mjs\` after an interrupted pack.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await writeFile(packageJsonPath, prepared, "utf8");
  } catch (error) {
    try {
      await restorePackageManifest(cwd);
    } catch (restoreError) {
      const failure = new Error(
        `Writing ${PACKAGE_JSON_PATH} failed and its source state could not be restored.`,
        { cause: error },
      );
      Object.assign(failure, { restoreError });
      throw failure;
    }
    throw error;
  }
  return true;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || (argv[0] !== "prepare" && argv[0] !== "restore")) {
    console.error("Usage: node scripts/package-manifest.mjs <prepare|restore>");
    process.exitCode = 1;
    return;
  }
  const changed =
    argv[0] === "prepare" ? await preparePackageManifest() : await restorePackageManifest();
  console.error(
    changed
      ? `package-manifest: ${argv[0] === "prepare" ? "sanitized" : "restored"} package.json.`
      : `package-manifest: no ${argv[0] === "prepare" ? "sanitation" : "cleanup"} needed.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
