import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parsePnpmLockfileSections,
  pnpmLockfileDocuments,
  resolveSnapshot,
} from "./pnpm-lockfile-documents.mjs";

type DependencyImpact = {
  importers: { root: string; dependencies: string[] }[];
  importerBindings?: { root: string; dependencies: string[] }[];
  pluginMetadataPaths?: string[];
  globalReason?: string;
};
type DependencyReference = { dependencyName: string; reference: string; specifier: string };
type Lockfile = ReturnType<typeof parsePnpmLockfileSections>;
const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies"];
const MANIFEST_METADATA = new Set([
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "contributors",
  "maintainers",
  "repository",
  "funding",
  "readme",
  "directories",
]);
const TEST_RUNTIME_PACKAGE = /^(?:vitest|@vitest\/[^/]+|vite|tsx)$/u;

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function readManifest(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid package manifest");
  }
  return Object.fromEntries(Object.entries(value));
}

function dependencyGroups(
  lockfile: Lockfile,
  root: string,
): Map<string, DependencyReference[]> | undefined {
  return lockfile.importerRoots.get(root);
}

function directDependencies(lockfile: Lockfile, root: string) {
  return [...(dependencyGroups(lockfile, root) ?? [])].flatMap(([group, references]) =>
    references.map((reference) => ({ group, ...reference })),
  );
}

function closure(lockfile: Lockfile, root: string, name: string) {
  const queue = directDependencies(lockfile, root).filter(
    (entry) => entry.dependencyName === name && !entry.reference.startsWith("link:"),
  );
  if (queue.length === 0) {
    return null;
  }
  const nodes = new Map<string, string>();
  nodes.set("direct", stable(queue.map(({ group, reference }) => ({ group, reference }))));
  const pending = queue;
  while (pending.length) {
    const entry = pending.pop()!;
    const resolved = resolveSnapshot({
      ...entry,
      snapshots: lockfile.snapshots,
      includeLocal: true,
    });
    if (!resolved) {
      throw new Error(`unresolved dependency ${entry.dependencyName}`);
    }
    const key = resolved.snapshotKey;
    if (nodes.has(key)) {
      continue;
    }
    const snapshot = lockfile.snapshotBlocks.get(key);
    const metadata = lockfile.packageBlocks.get(key.split("(", 1)[0]);
    if (!snapshot || !metadata) {
      throw new Error(`missing resolved package metadata for ${entry.dependencyName}`);
    }
    nodes.set(key, `${snapshot.source}\n${metadata.source}`);
    for (const references of Object.values(lockfile.snapshots[key])) {
      for (const [dependencyName, reference] of Object.entries(references ?? {})) {
        if (typeof reference !== "string") {
          throw new Error(`invalid dependency reference for ${dependencyName}`);
        }
        pending.push({
          group: "dependencies",
          dependencyName,
          reference,
          specifier: "",
        });
      }
    }
  }
  return createHash("sha256")
    .update(stable([...nodes].toSorted(([left], [right]) => left.localeCompare(right))))
    .digest("hex");
}

/** Compare exact merge-base resolution with the candidate without installing packages. */
export function resolveChangedDependencies(options: {
  cwd: string;
  baseRef?: string;
  changedPaths: string[];
}): DependencyImpact {
  const manifests = options.changedPaths.filter((file) => /(?:^|\/)package\.json$/u.test(file));
  if (!manifests.length && !options.changedPaths.includes("pnpm-lock.yaml")) {
    return { importers: [] };
  }
  const fallback = (reason: string): DependencyImpact => ({ importers: [], globalReason: reason });
  if (!options.baseRef) {
    return fallback("dependency resolution requires an exact base revision");
  }
  const readBase = (file: string) =>
    execFileSync("git", ["show", `${options.baseRef}:${file}`], {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const readCurrent = (file: string) => readFileSync(path.join(options.cwd, file), "utf8");
  try {
    const manifestPairs = [];
    const pluginMetadataPaths: string[] = [];
    for (const file of manifests) {
      if (path.posix.normalize(file) !== file || file.startsWith("../") || path.isAbsolute(file)) {
        return fallback("invalid package manifest path");
      }
      const before = readManifest(readBase(file));
      const after = readManifest(readCurrent(file));
      manifestPairs.push({ file, before, after });
      const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (key) =>
          !DEPENDENCY_GROUPS.includes(key) &&
          !MANIFEST_METADATA.has(key) &&
          stable(before[key]) !== stable(after[key]),
      );
      if (fields.length) {
        if (
          /^extensions\/[^/]+\/package\.json$/u.test(file) &&
          fields.every((field) => field === "openclaw")
        ) {
          pluginMetadataPaths.push(file);
          continue;
        }
        return fallback(
          `package manifest execution or resolution changed: ${file} (${fields.toSorted().join(", ")})`,
        );
      }
    }
    const beforeDocuments = pnpmLockfileDocuments(readBase("pnpm-lock.yaml"));
    const afterDocuments = pnpmLockfileDocuments(readCurrent("pnpm-lock.yaml"));
    if (beforeDocuments.environment !== afterDocuments.environment) {
      return fallback("pnpm package-manager environment changed");
    }
    const before = parsePnpmLockfileSections(beforeDocuments.dependencies);
    const after = parsePnpmLockfileSections(afterDocuments.dependencies);
    for (const lockfile of [before, after]) {
      if (
        !lockfile.hasImportersSection ||
        !lockfile.hasSnapshotsSection ||
        !lockfile.hasPackagesSection ||
        !lockfile.importerRoots.has(".")
      ) {
        return fallback("incomplete pnpm dependency resolution");
      }
      if (
        !/^lockfileVersion: ['"]?9\.0['"]?$/u.test(
          lockfile.globalBlocks.get("lockfileVersion")?.source ?? "",
        )
      ) {
        return fallback("unsupported pnpm lockfile version");
      }
    }
    for (const manifest of manifestPairs) {
      const root = path.posix.dirname(manifest.file);
      for (const [lockfile, document] of [
        [before, manifest.before],
        [after, manifest.after],
      ] as const) {
        for (const group of DEPENDENCY_GROUPS) {
          const value = document[group];
          if (
            value !== undefined &&
            (!value || typeof value !== "object" || Array.isArray(value))
          ) {
            return fallback(`invalid dependency declarations: ${manifest.file}`);
          }
          const declarations = new Map(Object.entries(value ?? {}));
          const references = dependencyGroups(lockfile, root)?.get(group) ?? [];
          if (
            declarations.size !== references.length ||
            references.some((entry) => declarations.get(entry.dependencyName) !== entry.specifier)
          ) {
            return fallback(`package manifest and lockfile disagree: ${manifest.file} (${group})`);
          }
        }
      }
    }
    const globalKeys = new Set([...before.globalBlocks.keys(), ...after.globalBlocks.keys()]);
    for (const key of globalKeys) {
      // Overrides are reflected in concrete resolutions below. Installation policy is global.
      if (
        key !== "overrides" &&
        before.globalBlocks.get(key)?.source !== after.globalBlocks.get(key)?.source
      ) {
        return fallback(`pnpm global resolution setting changed: ${key}`);
      }
    }
    const importers: DependencyImpact["importers"] = [];
    const importerBindings: DependencyImpact["importers"] = [];
    const roots = [
      ...new Set([...before.importerRoots.keys(), ...after.importerRoots.keys()]),
    ].toSorted((left, right) => left.localeCompare(right));
    for (const root of roots) {
      // Unchanged bindings still shadow the root package in workspace consumers.
      if (after.importerRoots.has(root)) {
        importerBindings.push({
          root,
          dependencies: [
            ...new Set(directDependencies(after, root).map((entry) => entry.dependencyName)),
          ].toSorted(),
        });
      }
      if ((before.importerMetadata.get(root) ?? "") !== (after.importerMetadata.get(root) ?? "")) {
        return fallback(`workspace installation metadata changed: ${root}`);
      }
      // Source reachability owns workspace links. Expanding their entire runtime
      // closure here would make every plugin's openclaw link fan out across core.
      const links = (lockfile: Lockfile) =>
        stable(
          directDependencies(lockfile, root)
            .filter((entry) => entry.reference.startsWith("link:"))
            .map(({ group, dependencyName, reference }) => ({ group, dependencyName, reference })),
        );
      if (links(before) !== links(after)) {
        return fallback(`workspace dependency link changed: ${root}`);
      }
      const names = [
        ...new Set(
          [...directDependencies(before, root), ...directDependencies(after, root)].map(
            (entry) => entry.dependencyName,
          ),
        ),
      ].toSorted();
      const dependencies = names.filter(
        (name) => closure(before, root, name) !== closure(after, root, name),
      );
      if (root === "." && dependencies.some((name) => TEST_RUNTIME_PACKAGE.test(name))) {
        return fallback(
          `shared Node test runtime changed: ${dependencies.filter((name) => TEST_RUNTIME_PACKAGE.test(name)).join(", ")}`,
        );
      }
      if (dependencies.length) {
        importers.push({ root, dependencies });
      }
    }
    return {
      importers,
      importerBindings,
      ...(pluginMetadataPaths.length ? { pluginMetadataPaths } : {}),
    };
  } catch {
    return fallback("dependency resolution could not be verified against the base revision");
  }
}
