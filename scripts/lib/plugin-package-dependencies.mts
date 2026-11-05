// Collects runtime dependency specs from bundled plugin packages.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type RuntimeDependencyPackageJson = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

/** Collect dependencies and optionalDependencies needed at plugin runtime. */
export function collectRuntimeDependencySpecs(packageJson: RuntimeDependencyPackageJson = {}) {
  return new Map(
    [
      ...Object.entries(packageJson.dependencies ?? {}),
      ...Object.entries(packageJson.optionalDependencies ?? {}),
    ].filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string" && entry[1].length > 0;
    }),
  );
}

/** Extract an npm package name from a bare module specifier. */
export function packageNameFromSpecifier(specifier: string) {
  if (
    typeof specifier !== "string" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const [first, second] = specifier.split("/");
  if (!first) {
    return null;
  }
  if (first.startsWith("@")) {
    return second ? `${first}/${second}` : null;
  }
  return first;
}

type PackageSourceOptions = { ref?: string };

function readPluginPackages(bundledPluginsDir: string, { ref }: PackageSourceOptions) {
  if (ref) {
    const root = path.dirname(path.resolve(bundledPluginsDir));
    const directory = path.basename(bundledPluginsDir);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      });
    return git("ls-tree", "--name-only", "-rz", ref, "--", directory)
      .split("\0")
      .filter((file) => file.split("/").length === 3 && file.endsWith("/package.json"))
      .toSorted((left, right) => left.localeCompare(right))
      .map((file) => ({
        pluginId: path.posix.basename(path.posix.dirname(file)),
        packageJson: JSON.parse(git("show", `${ref}:${file}`)),
      }));
  }
  if (!fs.existsSync(bundledPluginsDir)) {
    return [];
  }
  return fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(bundledPluginsDir, entry.name, "package.json"))
    .filter((file) => fs.existsSync(file))
    .toSorted((left, right) => left.localeCompare(right))
    .map((file) => ({
      pluginId: path.basename(path.dirname(file)),
      packageJson: JSON.parse(fs.readFileSync(file, "utf8")),
    }));
}

/** Collect runtime dependency specs across bundled plugin packages and note conflicts. */
export function collectBundledPluginPackageDependencySpecs(
  bundledPluginsDir: string,
  options: PackageSourceOptions = {},
) {
  const specs = new Map<
    string,
    { conflicts: Array<{ pluginId: string; spec: string }>; pluginIds: string[]; spec: string }
  >();

  for (const { pluginId, packageJson } of readPluginPackages(bundledPluginsDir, options)) {
    // External official plugins own isolated npm projects, so their dependency
    // specs do not need to match packages bundled into the root distribution.
    if (packageJson.openclaw?.build?.bundledDist === false) {
      continue;
    }
    for (const [name, spec] of collectRuntimeDependencySpecs(packageJson)) {
      const existing = specs.get(name);
      if (existing) {
        if (existing.spec !== spec) {
          existing.conflicts.push({ pluginId, spec });
        } else if (!existing.pluginIds.includes(pluginId)) {
          existing.pluginIds.push(pluginId);
        }
        continue;
      }
      specs.set(name, { conflicts: [], pluginIds: [pluginId], spec });
    }
  }

  return specs;
}

export function collectBundledPluginPackageDependencyErrors(
  bundledPluginsDir: string,
  options: PackageSourceOptions = {},
) {
  return [...collectBundledPluginPackageDependencySpecs(bundledPluginsDir, options)]
    .flatMap(([dependencyName, record]) =>
      record.conflicts.map(
        (conflict) =>
          `bundled plugin package dependency '${dependencyName}' has conflicting specs: ${record.pluginIds.join(", ")} use '${record.spec}', ${conflict.pluginId} uses '${conflict.spec}'.`,
      ),
    )
    .toSorted((left, right) => left.localeCompare(right));
}
