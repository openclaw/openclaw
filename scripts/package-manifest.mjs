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

function preparedPackageManifest(content, platformOptionals = {}) {
  const packageJson = JSON.parse(content);
  let changed = false;

  // npm 10's global bundle loader promotes hoisted optional children to prod
  // dependencies. Explicit optional edges retain platform filtering even then.
  for (const [name, version] of Object.entries(platformOptionals)) {
    if (packageJson.optionalDependencies?.[name] !== undefined) {
      continue;
    }
    packageJson.optionalDependencies ??= {};
    packageJson.optionalDependencies[name] = version;
    changed = true;
  }

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
  return changed ? `${JSON.stringify(packageJson, null, 2)}\n` : content;
}

/** Restore package.json after prepack prepared it for publishing. */
export async function restorePackageManifest(cwd = process.cwd()) {
  const backupPath = path.join(cwd, BACKUP_PATH);
  if (!existsSync(backupPath)) {
    return false;
  }
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const [receipt, current] = await Promise.all([
    readFile(backupPath, "utf8"),
    readFile(packageJsonPath, "utf8"),
  ]);
  const stored = JSON.parse(receipt);
  const captured =
    Object.keys(stored).length === 2 &&
    typeof stored.original === "string" &&
    typeof stored.prepared === "string";
  // v2026.9.8 left raw manifests here after interrupted packs. Recover those
  // using the prior source-only transform, without resolving dependencies.
  const original = captured ? stored.original : receipt;
  const prepared = captured ? stored.prepared : preparedPackageManifest(receipt);
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
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const backupPath = path.join(cwd, BACKUP_PATH);
  const original = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(original);
  const bundles = packageJson.bundleDependencies ?? packageJson.bundledDependencies;
  let platformOptionals = {};
  if (bundles === true || (Array.isArray(bundles) && bundles.length > 0)) {
    const { collectNpmPlatformOptionalDependencies, generateNpmPackageLock } =
      await import("./generate-npm-package-lock.mts");
    platformOptionals = collectNpmPlatformOptionalDependencies(
      JSON.parse(generateNpmPackageLock(cwd)),
    );
  }
  const prepared = preparedPackageManifest(original, platformOptionals);
  if (prepared === original) {
    return false;
  }
  if ((await readFile(packageJsonPath, "utf8")) !== original) {
    throw new Error(`${PACKAGE_JSON_PATH} changed while preparing its dependency graph.`);
  }
  await mkdir(path.dirname(backupPath), { recursive: true });
  try {
    // Keep exact prepared bytes so recovery never depends on registry availability.
    await writeFile(backupPath, JSON.stringify({ original, prepared }), {
      encoding: "utf8",
      flag: "wx",
    });
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
