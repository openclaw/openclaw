import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectRootPackageExcludedExtensionDirs } from "./lib/bundled-plugin-build-entries.mjs";
import { linkSourcePluginDependencies } from "./lib/bundled-plugin-dependency-links.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

export function parseDockerPluginKeepList(value) {
  if (typeof value !== "string") {
    return new Set();
  }
  return new Set(value.split(/[\s,]+/u).filter(Boolean));
}

function readPackageJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectRuntimeDependencyNames(packageJson, options = {}) {
  const dependencies = new Set();
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const dependencyName of Object.keys(packageJson?.[field] ?? {})) {
      dependencies.add(dependencyName);
    }
  }
  for (const dependencyName of Object.keys(packageJson?.peerDependencies ?? {})) {
    const optional = packageJson?.peerDependenciesMeta?.[dependencyName]?.optional === true;
    if (options.includeOptionalPeers === true || !optional) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function nodeModulePath(repoRoot, packageName) {
  return path.join(repoRoot, "node_modules", ...packageName.split("/"));
}

function runtimeDependencySeed(importerDir, packageName, packageJson) {
  return {
    importerDir,
    packageName,
    required:
      !Object.hasOwn(packageJson?.optionalDependencies ?? {}, packageName) &&
      (Object.hasOwn(packageJson?.dependencies ?? {}, packageName) ||
        packageJson?.peerDependenciesMeta?.[packageName]?.optional !== true),
  };
}

// Follow Node's importer-relative lookup: hoisted installs can contain several versions,
// and root-only traversal can misclassify a kept dependency as exclusive to an omitted plugin.
function resolveNodeModulePackageDir(importerDir, packageName, unresolvedLinks) {
  let currentDir = fs.realpathSync(importerDir);

  while (true) {
    const packageDir = path.join(currentDir, "node_modules", ...packageName.split("/"));
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      return fs.realpathSync(packageDir);
    }
    if (unresolvedLinks && fs.lstatSync(packageDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      unresolvedLinks.push(
        path.join(fs.realpathSync(path.dirname(packageDir)), path.basename(packageDir)),
      );
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function removeEmptyScopeDir(repoRoot, packageName) {
  if (!packageName.startsWith("@")) {
    return;
  }
  const [scope] = packageName.split("/");
  const scopeDir = path.join(repoRoot, "node_modules", scope);
  try {
    fs.rmdirSync(scopeDir);
  } catch {
    // Scope still has other packages or does not exist.
  }
}

// Only unresolved required dependency links need this traversal. Track each
// alias before excluded-workspace cleanup, and cap inspection at 40 hops rather
// than letting a cycle or pathological chain spin.
function requiredDependencyLinkChain(link) {
  const aliases = new Set();
  let current = link;
  while (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const alias = path.join(fs.realpathSync(path.dirname(current)), path.basename(current));
    if (aliases.has(alias)) {
      throw new Error(`Docker required dependency has a symlink cycle: ${link}`);
    }
    if (aliases.size >= 40) {
      throw new Error(`Docker required dependency exceeds 40 symlink hops: ${link}`);
    }
    aliases.add(alias);
    current = path.resolve(path.dirname(alias), fs.readlinkSync(alias));
  }
  return aliases;
}

function collectPackageRuntimeClosure(repoRoot, seeds, options = {}) {
  const packageDirs = new Set();
  const rootPackageNames = new Set();
  const unresolvedRequiredLinks = new Set();
  const stack = [...seeds];

  while (stack.length > 0) {
    const entry = stack.pop();
    const unresolvedLinks = [];
    const packageDir = resolveNodeModulePackageDir(
      entry.importerDir,
      entry.packageName,
      unresolvedLinks,
    );
    if (!packageDir) {
      if (entry.required !== false) {
        for (const link of unresolvedLinks) {
          for (const alias of requiredDependencyLinkChain(link)) {
            unresolvedRequiredLinks.add(alias);
          }
        }
      }
      continue;
    }

    const rootPackageDir = nodeModulePath(repoRoot, entry.packageName);
    if (
      fs.existsSync(path.join(rootPackageDir, "package.json")) &&
      fs.realpathSync(rootPackageDir) === packageDir
    ) {
      rootPackageNames.add(entry.packageName);
    }
    if (packageDirs.has(packageDir)) {
      continue;
    }
    packageDirs.add(packageDir);

    const packageJson = readPackageJson(path.join(packageDir, "package.json"));
    for (const dependencyName of collectRuntimeDependencyNames(packageJson, options)) {
      stack.push(runtimeDependencySeed(packageDir, dependencyName, packageJson));
    }
  }

  return { packageDirs, rootPackageNames, unresolvedRequiredLinks };
}

function collectWorkspacePackageRuntimeSeeds(repoRoot, workspaceDir, excludedPluginIds) {
  const seeds = [];
  const workspaceRoot = path.join(repoRoot, workspaceDir);
  if (!fs.existsSync(workspaceRoot)) {
    return seeds;
  }

  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || excludedPluginIds.has(entry.name)) {
      continue;
    }
    const importerDir = path.join(workspaceRoot, entry.name);
    const packageJson = readPackageJson(path.join(importerDir, "package.json"));
    if (typeof packageJson?.name === "string") {
      seeds.push({ importerDir, packageName: packageJson.name });
    }
    for (const packageName of collectRuntimeDependencyNames(packageJson)) {
      seeds.push(runtimeDependencySeed(importerDir, packageName, packageJson));
    }
  }
  return seeds;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

// pnpm's aggregate and importer-local aliases outlive their workspace targets.
// Snapshot only aliases into deliberately excluded importers before pruning those
// targets; unrelated dangling links remain errors for immutable-image acceptance.
function collectExcludedWorkspaceDependencyLinks(repoRoot, bundledPluginDir, excludedRoots) {
  const realRepoRoot = fs.realpathSync(repoRoot);
  const moduleRoots = [path.join(repoRoot, "node_modules")];
  for (const workspaceDir of ["packages", bundledPluginDir]) {
    const workspaceRoot = path.join(repoRoot, workspaceDir);
    assertRealOutputRoot(workspaceRoot);
    if (!fs.existsSync(workspaceRoot)) {
      continue;
    }
    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        moduleRoots.push(path.join(workspaceRoot, entry.name, "node_modules"));
      }
    }
  }
  const links = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isSymbolicLink()) {
        let target = path.resolve(fs.realpathSync(path.dirname(file)), fs.readlinkSync(file));
        try {
          target = fs.realpathSync(file);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        if (excludedRoots.some((root) => isWithin(root, target))) {
          links.push(file);
        }
      }
    }
  };
  const existingRoots = moduleRoots.filter((root) => {
    assertRealOutputRoot(root);
    return fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory();
  });
  for (const moduleRoot of existingRoots) {
    if (!isWithin(realRepoRoot, fs.realpathSync(moduleRoot))) {
      throw new Error(`Docker dependency root escapes repository: ${moduleRoot}`);
    }
  }
  for (const moduleRoot of existingRoots) {
    visit(moduleRoot);
  }
  return links.toSorted((left, right) => left.localeCompare(right));
}

function pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds) {
  const rootPackageJson = readPackageJson(path.join(repoRoot, "package.json"));
  const omittedPackageNames = new Set();
  const omittedSeeds = [];

  for (const pluginId of omittedPluginIds) {
    const importerDir = path.join(repoRoot, bundledPluginDir, pluginId);
    const packageJson = readPackageJson(path.join(importerDir, "package.json"));
    if (typeof packageJson?.name === "string") {
      omittedPackageNames.add(packageJson.name);
    }
    for (const packageName of collectRuntimeDependencyNames(packageJson)) {
      omittedSeeds.push(runtimeDependencySeed(importerDir, packageName, packageJson));
    }
  }

  const keptSeeds = [...collectRuntimeDependencyNames(rootPackageJson)].map((packageName) =>
    runtimeDependencySeed(repoRoot, packageName, rootPackageJson),
  );
  keptSeeds.push(...collectWorkspacePackageRuntimeSeeds(repoRoot, "packages", new Set()));
  keptSeeds.push(
    ...collectWorkspacePackageRuntimeSeeds(repoRoot, bundledPluginDir, omittedPluginIds),
  );

  const keptClosure = collectPackageRuntimeClosure(repoRoot, keptSeeds);
  // The browser UI workspace is build-only; its generated dist/control-ui is
  // shipped, but its importer root is not. Omitted plugins have the same closure
  // boundary. Never prune a workspace that retained runtime code actually needs.
  const realRepoRoot = fs.realpathSync(repoRoot);
  const excludedRoots = [
    path.join(realRepoRoot, "ui"),
    ...[...omittedPluginIds].map((id) => path.join(realRepoRoot, bundledPluginDir, id)),
  ];
  for (const packageDir of keptClosure.packageDirs) {
    if (excludedRoots.some((root) => isWithin(root, packageDir))) {
      throw new Error(
        `Docker runtime dependency resolves to excluded workspace: ${path.relative(realRepoRoot, packageDir).replaceAll("\\", "/")}`,
      );
    }
  }
  const excludedLinks = collectExcludedWorkspaceDependencyLinks(
    repoRoot,
    bundledPluginDir,
    excludedRoots,
  );
  for (const link of excludedLinks) {
    const canonicalLink = path.join(fs.realpathSync(path.dirname(link)), path.basename(link));
    if (keptClosure.unresolvedRequiredLinks.has(canonicalLink)) {
      throw new Error(
        `Docker required dependency is missing from excluded workspace: ${path.relative(realRepoRoot, canonicalLink).replaceAll("\\", "/")}`,
      );
    }
  }
  // Hoisted workspace dev dependencies can satisfy optional peers of omitted
  // plugins. Treat those installed peer-only branches as removal candidates;
  // the kept runtime closure below remains authoritative.
  const omittedClosure = collectPackageRuntimeClosure(repoRoot, omittedSeeds, {
    includeOptionalPeers: true,
  });
  const removed = [];
  const removalCandidates = new Set([...omittedPackageNames, ...omittedClosure.rootPackageNames]);

  for (const packageName of [...removalCandidates].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const packageDir = nodeModulePath(repoRoot, packageName);
    if (!fs.existsSync(packageDir)) {
      continue;
    }
    if (keptClosure.packageDirs.has(fs.realpathSync(packageDir))) {
      continue;
    }
    removePathIfExists(packageDir);
    removeEmptyScopeDir(repoRoot, packageName);
    removed.push(path.relative(repoRoot, packageDir).replaceAll("\\", "/"));
  }

  for (const link of excludedLinks) {
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(link);
      removed.push(path.relative(repoRoot, link).replaceAll("\\", "/"));
    }
  }

  return removed;
}

// Docker compiles selected externally distributed plugins into the unified dist
// graph, but their dependencies stay plugin-local under the isolated pnpm install
// instead of the root node_modules that dist/extensions/<id> can reach. Link them
// under the packaged root, as isolated source checkouts do, and fail closed when a
// declared dependency still does not resolve from there: the plugin would otherwise
// ship loadable-looking but be rejected by dependency diagnostics at runtime.
function linkRetainedPluginDependencies(repoRoot, bundledPluginDir, retainedPluginIds) {
  const unreachable = [];
  for (const pluginId of [...retainedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const distPluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
    if (!fs.existsSync(distPluginDir)) {
      continue;
    }
    const pluginDir = path.join(repoRoot, bundledPluginDir, pluginId);
    const distNodeModules = path.join(distPluginDir, "node_modules");
    fs.rmSync(distNodeModules, { recursive: true, force: true });
    linkSourcePluginDependencies(pluginDir, distNodeModules);
    const packageJson = readPackageJson(path.join(pluginDir, "package.json"));
    for (const packageName of Object.keys(packageJson?.dependencies ?? {})) {
      if (
        !(packageName in (packageJson.optionalDependencies ?? {})) &&
        !resolveNodeModulePackageDir(distPluginDir, packageName)
      ) {
        unreachable.push(`${pluginId}: ${packageName}`);
      }
    }
  }
  if (unreachable.length > 0) {
    throw new Error(
      `plugin dependencies are not reachable from their packaged dist roots:\n${unreachable.join("\n")}`,
    );
  }
}

export function pruneDockerPluginDist(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const bundledPluginDir = env.OPENCLAW_BUNDLED_PLUGIN_DIR ?? "extensions";
  const keepPluginIds = parseDockerPluginKeepList(env.OPENCLAW_EXTENSIONS);
  const excludedPluginIds = collectRootPackageExcludedExtensionDirs({ cwd: repoRoot });
  const omittedPluginIds = new Set(
    [...excludedPluginIds].filter((pluginId) => !keepPluginIds.has(pluginId)),
  );
  const removed = [];

  // The removals below recurse into dist/ and dist-runtime/ plugin trees;
  // refuse to follow a symlinked output root into its target.
  assertRealOutputRoot(path.join(repoRoot, "dist"));
  assertRealOutputRoot(path.join(repoRoot, "dist-runtime"));

  removed.push(...pruneNodeModulesForOmittedPlugins(repoRoot, bundledPluginDir, omittedPluginIds));

  for (const pluginId of [...omittedPluginIds].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    for (const pluginPath of [
      path.join(bundledPluginDir, pluginId),
      path.join("dist", "extensions", pluginId),
      path.join("dist-runtime", "extensions", pluginId),
    ]) {
      const absolutePluginPath = path.join(repoRoot, pluginPath);
      if (!fs.existsSync(absolutePluginPath)) {
        continue;
      }
      removePathIfExists(absolutePluginPath);
      removed.push(path.relative(repoRoot, absolutePluginPath).replaceAll("\\", "/"));
    }
  }

  linkRetainedPluginDependencies(
    repoRoot,
    bundledPluginDir,
    [...excludedPluginIds].filter((pluginId) => keepPluginIds.has(pluginId)),
  );

  return removed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  pruneDockerPluginDist();
}
