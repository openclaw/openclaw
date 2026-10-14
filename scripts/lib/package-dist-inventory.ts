import fs from "node:fs/promises";
import path from "node:path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { writeJson } from "../../src/infra/json-files.ts";
import {
  collectPackageDistContentInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  collectPackageDistInventory,
} from "../../src/infra/package-dist-inventory.ts";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";

export { LOCAL_BUILD_METADATA_DIST_PATHS } from "./local-build-metadata-paths.mts";
export { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory-contract.mts";

const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isInstallStageDirName(value: string): boolean {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

export function isLegacyPluginDependencyInstallStagePath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/");
  return (
    parts.length >= 4 &&
    parts[0]?.toLowerCase() === "dist" &&
    parts[1]?.toLowerCase() === "extensions" &&
    Boolean(parts[2]) &&
    isInstallStageDirName(parts[3] ?? "")
  );
}

async function collectLegacyPluginDependencyStagingDebrisPaths(
  packageRoot: string,
): Promise<string[]> {
  const { entries, failedDirs } = await walkDirectory(packageRoot, {
    maxDepth: 4,
    symlinks: "include",
    descend: ({ depth, name }) =>
      depth === 1
        ? name.toLowerCase() === "dist"
        : depth === 2
          ? name.toLowerCase() === "extensions"
          : depth === 3,
    include: ({ depth, name }) => depth === 4 && isInstallStageDirName(name),
  });
  const failure = failedDirs.find(({ error }) => !hasErrnoCode(error, "ENOENT"));
  if (failure) {
    throw failure.error;
  }
  return entries
    .map((entry) => normalizeRelativePath(entry.relativePath))
    .toSorted((left, right) => left.localeCompare(right));
}

async function assertNoLegacyPluginDependencyStagingDebris(packageRoot: string): Promise<void> {
  const debris = await collectLegacyPluginDependencyStagingDebrisPaths(packageRoot);
  if (debris.length === 0) {
    return;
  }
  throw new Error(
    `unexpected legacy plugin dependency staging debris in package dist: ${debris.join(", ")}`,
  );
}

async function writePackageDistInventoryFile(
  packageRoot: string,
  entries: string[],
): Promise<string[]> {
  const files = entries.filter((entry) => entry !== PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH);
  const content = await collectPackageDistContentInventory(packageRoot, files);
  await writeJson(path.join(packageRoot, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH), content, {
    mode: 0o644,
    trailingNewline: true,
  });
  const inventory = sortUniqueStrings([...files, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH]);
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  await writeJson(inventoryPath, inventory, { mode: 0o644, trailingNewline: true });
  return inventory;
}

export async function writePackageDistInventory(packageRoot: string): Promise<string[]> {
  await assertNoLegacyPluginDependencyStagingDebris(packageRoot);
  return writePackageDistInventoryFile(packageRoot, await collectPackageDistInventory(packageRoot));
}

async function writePackageLifecyclePendingMarker(packageRoot: string): Promise<void> {
  const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, "pending\n", "utf8");
}

export async function writePackageDistInventoryForPublish(packageRoot: string): Promise<string[]> {
  const inventory = await writePackageDistInventory(packageRoot);
  await writePackageLifecyclePendingMarker(packageRoot);
  return inventory;
}
