import type { PluginCompatRecord } from "../../src/plugins/compat/types.js";
import { isRecord } from "./record-shared.mjs";

export const shippedSurfacePath = "scripts/lib/plugin-sdk-shipped-surface.json";
const schema = "openclaw.plugin-sdk-shipped-surface/v1";
const stableReleasePattern = /^v(\d+)\.(\d+)\.(\d+)$/u;

export type PluginSdkShippedSurface = {
  schema: typeof schema;
  release: string;
  commit: string;
  entrypoints: Record<string, string[]>;
};

function stableVersion(release: string) {
  const match = stableReleasePattern.exec(release);
  const [, major, minor, patch] = match ?? [];
  if (!major || !minor || !patch) {
    throw new Error(`Expected a stable release tag (vX.Y.Z), got ${release}`);
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)] as const;
}

export function compareStableReleases(left: string, right: string): number {
  const leftVersion = stableVersion(left);
  const rightVersion = stableVersion(right);
  for (const index of [0, 1, 2] as const) {
    if (leftVersion[index] !== rightVersion[index]) {
      return leftVersion[index] > rightVersion[index] ? 1 : -1;
    }
  }
  return 0;
}

export function isStableRelease(release: string): boolean {
  return stableReleasePattern.test(release);
}

export function parsePluginSdkShippedSurface(value: unknown): PluginSdkShippedSurface {
  if (
    !isRecord(value) ||
    value.schema !== schema ||
    typeof value.release !== "string" ||
    !isStableRelease(value.release) ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.commit) ||
    !isRecord(value.entrypoints) ||
    Object.keys(value.entrypoints).length === 0
  ) {
    throw new Error(
      `Malformed ${shippedSurfacePath}: expected a stable release, commit, and typed entrypoints`,
    );
  }
  const entrypoints: Record<string, string[]> = {};
  for (const [subpath, names] of Object.entries(value.entrypoints)) {
    if (
      !/^[a-z0-9][a-z0-9./-]*$/u.test(subpath) ||
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string" || !name || name === "default") ||
      new Set(names).size !== names.length
    ) {
      throw new Error(`Malformed ${shippedSurfacePath}: invalid exports for ${subpath}`);
    }
    entrypoints[subpath] = names;
  }
  return { schema, release: value.release, commit: value.commit, entrypoints };
}

/** Private runtime facades without a types condition are not a declared public contract. */
export function typedPluginSdkSubpaths(packageJson: unknown): string[] {
  if (!isRecord(packageJson) || !isRecord(packageJson.exports)) {
    throw new Error("package.json must declare exports");
  }
  return Object.entries(packageJson.exports)
    .filter(
      ([key, value]) =>
        key.startsWith("./plugin-sdk/") && isRecord(value) && Object.hasOwn(value, "types"),
    )
    .map(([key]) => key.slice("./plugin-sdk/".length))
    .toSorted();
}

function isUtcDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export type PluginSdkShippedSurfaceFailure = {
  subpath: string;
  missingSubpath: boolean;
  names: string[];
};

/** Budgets cannot authorize removals; only dated, qualified compatibility records can. */
export function evaluatePluginSdkShippedSurface(
  inventory: PluginSdkShippedSurface,
  current: ReadonlyMap<string, readonly string[]>,
  records: readonly PluginCompatRecord[],
  now: string,
): PluginSdkShippedSurfaceFailure[] {
  if (!isUtcDate(now)) {
    throw new Error("OPENCLAW_PLUGIN_SDK_SURFACE_NOW must be a valid UTC date (YYYY-MM-DD)");
  }
  const authorized = new Set(
    records
      .filter(
        (record) =>
          ["deprecated", "removal-pending", "removed"].includes(record.status) &&
          record.removeAfter !== undefined &&
          isUtcDate(record.removeAfter) &&
          record.removeAfter < now,
      )
      .flatMap((record) => record.surfaces),
  );
  const failures: PluginSdkShippedSurfaceFailure[] = [];
  for (const [subpath, names] of Object.entries(inventory.entrypoints)) {
    const surface = `openclaw/plugin-sdk/${subpath}`;
    if (authorized.has(surface)) {
      continue;
    }
    const currentNames = current.get(subpath);
    const present = new Set(currentNames);
    const missing = names.filter(
      (name) =>
        !present.has(name) &&
        !authorized.has(`${surface}.${name}`) &&
        !authorized.has(`${surface} ${name}`),
    );
    // Qualified records cannot authorize deleting the entrypoint itself.
    if (currentNames === undefined || missing.length > 0) {
      failures.push({ subpath, missingSubpath: currentNames === undefined, names: missing });
    }
  }
  return failures;
}

export function formatPluginSdkShippedSurfaceFailures(
  inventory: PluginSdkShippedSurface,
  failures: readonly PluginSdkShippedSurfaceFailure[],
): string[] {
  if (failures.length === 0) {
    return [];
  }
  return [
    `Unauthorized removals from shipped Plugin SDK ${inventory.release}:`,
    ...failures.map(
      ({ subpath, missingSubpath, names }) =>
        `openclaw/plugin-sdk/${subpath}: ${missingSubpath ? "missing typed subpath; " : ""}${names.length} unauthorized missing names` +
        (names.length ? ` (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""})` : ""),
    ),
    "Restore the shipped surface, or add/extend a qualified compat record with a reached removeAfter (strictly before the current UTC date). Budgets do not authorize removal.",
  ];
}
