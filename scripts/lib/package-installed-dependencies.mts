import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "./record-shared.mjs";

type DependencyManifest = {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
};

export function validateBundledPackageName(name: string) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error(`Invalid bundled dependency name: ${name}`);
  }
}

export async function installedPackagePath(
  owner: string,
  name: string,
): Promise<string | undefined> {
  validateBundledPackageName(name);
  const search = createRequire(path.join(owner, "package.json")).resolve.paths(name) ?? [];
  for (const modules of search) {
    const candidate = path.join(modules, name);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return undefined;
}

export async function installedPackageDependencies(root: string, manifest: DependencyManifest) {
  const required = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const optional = isRecord(manifest.optionalDependencies) ? manifest.optionalDependencies : {};
  const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {};
  const peerMetadata = isRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
  const dependencies: Array<{ name: string; path: string; root: string }> = [];
  for (const name of Object.keys({ ...peers, ...required, ...optional })) {
    const dependency = await installedPackagePath(root, name);
    const metadata = peerMetadata[name];
    const isOptional =
      Object.hasOwn(optional, name) ||
      (!Object.hasOwn(required, name) && isRecord(metadata) && metadata.optional === true);
    if (!dependency) {
      if (isOptional) {
        continue;
      }
      throw new Error(
        `Linked bundle requires dependency-closure staging: ${root} is missing ${name}`,
      );
    }
    dependencies.push({ name, path: dependency, root: await fs.realpath(dependency) });
  }
  return dependencies;
}

export function hasInstalledPackageAncestor(
  destination: string,
  dependency: { name: string; root: string },
  ancestors: ReadonlyMap<string, string>,
): boolean {
  const search =
    createRequire(path.join(destination, "package.json")).resolve.paths(dependency.name) ?? [];
  for (const modules of search) {
    const root = ancestors.get(path.join(modules, dependency.name));
    if (root !== undefined) {
      // A nearer package shadows an outer match, just as it does in Node.
      return root === dependency.root;
    }
  }
  return false;
}
