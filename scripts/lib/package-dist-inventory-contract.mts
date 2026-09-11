import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";

const UNINVENTORIED_PACKAGE_DIST_PATHS = new Set([
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
]);

export function comparePackageDistInventory(params: {
  files: Iterable<string>;
  inventory: Iterable<string>;
}): {
  packagedFilesMissingFromInventory: string[];
  inventoryEntriesMissingFromPackage: string[];
} {
  const files = new Set(
    [...params.files]
      .map((entry) => entry.replace(/\\/gu, "/"))
      .filter((entry) => entry.startsWith("dist/")),
  );
  const inventory = new Set([...params.inventory].map((entry) => entry.replace(/\\/gu, "/")));

  return {
    packagedFilesMissingFromInventory: [...files]
      .filter((entry) => !UNINVENTORIED_PACKAGE_DIST_PATHS.has(entry) && !inventory.has(entry))
      .toSorted(),
    inventoryEntriesMissingFromPackage: [...inventory]
      .filter((entry) => !files.has(entry))
      .toSorted(),
  };
}

export const PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH =
  "dist/postinstall-content-inventory.json";
export type PackageDistContentInventoryEntry = {
  path: string;
  sha256: string;
  mode: number;
  size: number;
};

export function parsePackageDistContentInventory(
  value: unknown,
): PackageDistContentInventoryEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid package dist content inventory");
  }
  const seen = new Set<string>();
  return value
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("Invalid package dist content inventory entry");
      }
      const item = entry as PackageDistContentInventoryEntry;
      if (
        typeof item.path !== "string" ||
        !item.path.startsWith("dist/") ||
        item.path.includes("\\") ||
        item.path.includes("\0") ||
        item.path.split("/").some((part) => !part || part === "." || part === "..") ||
        item.path === PACKAGE_DIST_INVENTORY_RELATIVE_PATH ||
        item.path === PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        !Number.isSafeInteger(item.size) ||
        item.size < 0 ||
        !Number.isInteger(item.mode) ||
        item.mode < 0 ||
        item.mode > 0o777 ||
        seen.has(item.path)
      ) {
        throw new Error("Invalid package dist content inventory entry");
      }
      seen.add(item.path);
      return { path: item.path, sha256: item.sha256, size: item.size, mode: item.mode };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export function comparePackageDistContentInventory(
  expected: PackageDistContentInventoryEntry[],
  actual: PackageDistContentInventoryEntry[],
): string[] {
  const format = (entry: PackageDistContentInventoryEntry) =>
    `${entry.path}:${entry.sha256}:${entry.size}:${process.platform === "win32" ? "" : Boolean(entry.mode & 0o111)}`;
  return JSON.stringify(expected.map(format).toSorted()) ===
    JSON.stringify(actual.map(format).toSorted())
    ? []
    : [
        `Invalid package dist content inventory at ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}: expected packaged file hashes and executable bits to match current dist files.`,
      ];
}
