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

export function createPackageDistContentInventoryEntry(
  relativePath: string,
  hash: { bytes: number; digest: string },
  mode: number,
): PackageDistContentInventoryEntry {
  return {
    path: relativePath.replace(/\\/g, "/"),
    sha256: hash.digest,
    // Preserve special bits for the extra-execute safety check.
    mode: mode & 0o7777,
    size: hash.bytes,
  };
}

export function parsePackageDistContentInventory(
  value: unknown,
): PackageDistContentInventoryEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid package dist content inventory: malformed metadata");
  }
  const seen = new Set<string>();
  return value
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("Invalid package dist content inventory entry: malformed metadata");
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
        throw new Error("Invalid package dist content inventory entry: malformed metadata");
      }
      seen.add(item.path);
      return { path: item.path, sha256: item.sha256, size: item.size, mode: item.mode };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

export function comparePackageDistContentInventory(
  expected: PackageDistContentInventoryEntry[],
  actual: PackageDistContentInventoryEntry[],
  warnings?: string[],
): string[] {
  const format = (entry: PackageDistContentInventoryEntry) =>
    `${entry.path}:${entry.sha256}:${entry.size}`;
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  if (
    JSON.stringify(expected.map(format).toSorted()) !==
    JSON.stringify(actual.map(format).toSorted())
  ) {
    return [
      `Invalid package dist content inventory: content mismatch at ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}: expected packaged file hashes and sizes to match current dist files.`,
    ];
  }
  if (
    process.platform !== "win32" &&
    expected.some((entry) => {
      const mode = actualByPath.get(entry.path)!.mode;
      return entry.mode & 0o111 ? !(mode & 0o111) : Boolean(mode & 0o111) && Boolean(mode & 0o7022);
    })
  ) {
    return [
      `Invalid package dist content inventory: executable permission mismatch at ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}: expected packaged executable permissions to match current dist files.`,
    ];
  }
  // ACL-backed filesystems can add execute bits without changing packaged content.
  const extraExecutableFiles =
    process.platform === "win32"
      ? 0
      : expected.filter(
          (entry) => !(entry.mode & 0o111) && actualByPath.get(entry.path)!.mode & 0o111,
        ).length;
  if (extraExecutableFiles) {
    warnings?.push(
      `${extraExecutableFiles} packaged dist file(s) have extra execute bits; hashes and sizes match ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}. Continuing without changing file permissions.`,
    );
  }
  return [];
}
