#!/usr/bin/env node
// Reduces an installed OpenClaw package to the private macOS worker runtime.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPackageRootImports } from "../src/infra/package-root-imports.js";
import { runtimeProcessEntrypoints } from "../src/infra/runtime-process-entrypoints.js";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "./lib/package-dist-imports.mjs";
import { packageNameFromSpecifier } from "./lib/plugin-package-dependencies.mts";

const WORKER_ENTRY = "dist/mac-node-worker.js";
const REQUIRED_OPTIONAL_DEPENDENCIES = ["sqlite-vec"] as const;
const NODE_HOST_PLUGIN_MARKERS = [
  /\bnodeHostCommands\s*:/u,
  /\.registerNodeHostCommand\s*\(/u,
  /\bregisterComputerUseProvider\s*\(/u,
] as const;

type PackageManifest = {
  name?: string;
  version?: string;
  type?: string;
  openclaw?: unknown;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function walkFiles(root: string, relative = ""): string[] {
  const current = path.join(root, relative);
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = normalizeRelative(path.join(relative, entry.name));
    return entry.isDirectory() && !entry.isSymbolicLink() ? walkFiles(root, child) : [child];
  });
}

function collectExportRuntimeTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === "string") {
    if (/^\.\/dist\/.*\.[cm]?js$/u.test(value)) {
      targets.add(normalizeRelative(value));
    }
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const nested of Object.values(value)) {
      collectExportRuntimeTargets(nested, targets);
    }
  }
}

function collectCreatedRequireResolveImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const binding of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/gu,
  )) {
    const name = binding[1];
    if (!name) {
      continue;
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const resolveCall = new RegExp(`\\b${escaped}\\.resolve\\s*\\(\\s*["']([^"']+)["']`, "gu");
    for (const match of source.matchAll(resolveCall)) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}

function collectReferencedRuntimeProcessEntrypoints(source: string): string[] {
  const targets: string[] = [];
  for (const [name, entrypoint] of Object.entries(runtimeProcessEntrypoints)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const reference = new RegExp(`(?:\\.|\\?\\.)${escaped}\\b|["']${escaped}["']`, "u");
    if (reference.test(source)) {
      targets.push(`dist/${entrypoint.distWorkerPath}`);
    }
  }
  return targets;
}

function readManifest(packageRoot: string): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

function collectNodeHostPluginSeeds(packageRoot: string): string[] {
  const extensionsRoot = path.join(packageRoot, "dist/extensions");
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry) => {
      const pluginRoot = path.join(extensionsRoot, entry.name);
      const files = walkFiles(pluginRoot);
      const ownsNodeHostSurface = files.some((relative) => {
        if (!/\.[cm]?js$/u.test(relative)) {
          return false;
        }
        const source = fs.readFileSync(path.join(pluginRoot, relative), "utf8");
        return NODE_HOST_PLUGIN_MARKERS.some((marker) => marker.test(source));
      });
      return ownsNodeHostSurface
        ? files.map((relative) => `dist/extensions/${entry.name}/${relative}`)
        : [];
    });
}

function readNodeBuiltinModules(nodeExecutable: string): ReadonlySet<string> {
  const builtinModules: unknown = JSON.parse(
    execFileSync(
      nodeExecutable,
      [
        "--input-type=module",
        "--eval",
        'import { builtinModules } from "node:module"; process.stdout.write(JSON.stringify(builtinModules));',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  if (
    !Array.isArray(builtinModules) ||
    !builtinModules.every((name: unknown): name is string => typeof name === "string")
  ) {
    throw new Error(`Mac worker Node runtime returned invalid builtin modules: ${nodeExecutable}`);
  }
  return new Set(builtinModules);
}

function collectOwnedPackageDependencies(
  packageRoot: string,
  dependencies: Set<string>,
  nodeBuiltinModules: ReadonlySet<string>,
): void {
  const pending = [...dependencies].filter((name) => name.startsWith("@openclaw/"));
  const visited = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    const installedRoot = path.join(packageRoot, "node_modules", name);
    if (!fs.existsSync(installedRoot)) {
      continue;
    }
    for (const relative of walkFiles(installedRoot)) {
      if (relative.startsWith("node_modules/") || !/\.[cm]?js$/u.test(relative)) {
        continue;
      }
      const source = fs.readFileSync(path.join(installedRoot, relative), "utf8");
      for (const specifier of [
        ...collectPackageRootImports(source),
        ...collectCreatedRequireResolveImports(source),
      ]) {
        const dependency = packageNameFromSpecifier(specifier);
        if (!dependency || dependency === "openclaw" || nodeBuiltinModules.has(dependency)) {
          continue;
        }
        if (!dependencies.has(dependency)) {
          dependencies.add(dependency);
          if (dependency.startsWith("@openclaw/")) {
            pending.push(dependency);
          }
        }
      }
    }
  }
}

function collectSeeds(packageRoot: string, manifest: PackageManifest): Set<string> {
  const seeds = new Set([WORKER_ENTRY, "dist/build-info.json"]);
  for (const entrypoint of [
    runtimeProcessEntrypoints.imageProcessor,
    runtimeProcessEntrypoints.sqliteStore,
  ]) {
    seeds.add(`dist/${entrypoint.distWorkerPath}`);
  }
  for (const relative of collectNodeHostPluginSeeds(packageRoot)) {
    seeds.add(relative);
  }
  const skillsRoot = path.join(packageRoot, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const relative of walkFiles(skillsRoot)) {
      seeds.add(`skills/${relative}`);
    }
  }
  for (const [exportName, target] of Object.entries(manifest.exports ?? {})) {
    if (exportName.startsWith("./plugin-sdk/")) {
      collectExportRuntimeTargets(target, seeds);
    }
  }
  return seeds;
}

export function planMacNodeWorkerClosure(
  packageRoot: string,
  nodeExecutable: string,
): {
  dependencies: string[];
  files: string[];
} {
  const manifest = readManifest(packageRoot);
  if (manifest.name !== "openclaw" || !manifest.version) {
    throw new Error("Mac worker closure requires an installed OpenClaw package");
  }
  // The installed Node target owns these facts, including when Bun runs the planner.
  const nodeBuiltinModules = readNodeBuiltinModules(nodeExecutable);
  const packageFiles = walkFiles(packageRoot).filter(
    (relative) => relative !== "package.json" && !relative.startsWith("node_modules/"),
  );
  const packageFileSet = new Set(packageFiles);
  const files = collectSeeds(packageRoot, manifest);
  const pending = [...files];
  while (pending.length) {
    const importerPath = pending.pop()!;
    if (!/\.[cm]?js$/u.test(importerPath)) {
      continue;
    }
    if (!packageFileSet.has(importerPath)) {
      throw new Error(`Mac worker closure seed is missing: ${importerPath}`);
    }
    const source = fs.readFileSync(path.join(packageRoot, importerPath), "utf8");
    // Descriptor properties and named launch IDs are executable edges, not
    // module imports. Follow both in retained chunks and workers; quoted IDs
    // also cover conditional selection and renamed resolver bindings.
    for (const runtimeTarget of collectReferencedRuntimeProcessEntrypoints(source)) {
      if (!files.has(runtimeTarget)) {
        files.add(runtimeTarget);
        pending.push(runtimeTarget);
      }
    }
    for (const { importedPath } of collectPackageDistImports({
      files: [importerPath],
      readText: () => source,
    })) {
      if (!files.has(importedPath)) {
        files.add(importedPath);
        pending.push(importedPath);
      }
    }
  }
  const orderedFiles = [...files].toSorted((left, right) => left.localeCompare(right));
  const importErrors = collectPackageDistImportErrors({
    files: orderedFiles,
    readText: (relative: string) => fs.readFileSync(path.join(packageRoot, relative), "utf8"),
  });
  if (importErrors.length) {
    throw new Error(`Mac worker dist closure is incomplete:\n${importErrors.join("\n")}`);
  }
  const dependencies = new Set<string>(REQUIRED_OPTIONAL_DEPENDENCIES);
  for (const relative of orderedFiles) {
    if (!/\.[cm]?js$/u.test(relative)) {
      continue;
    }
    const source = fs.readFileSync(path.join(packageRoot, relative), "utf8");
    for (const specifier of [
      ...collectPackageRootImports(source),
      ...collectCreatedRequireResolveImports(source),
    ]) {
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName && packageName !== "openclaw" && !nodeBuiltinModules.has(packageName)) {
        dependencies.add(packageName);
      }
    }
  }
  // Internal packages are published without their own dependency declarations;
  // the root package owns those specs. Follow their built imports so pruning an
  // otherwise unrelated root dependency cannot break a retained internal chunk.
  collectOwnedPackageDependencies(packageRoot, dependencies, nodeBuiltinModules);
  return {
    dependencies: [...dependencies].toSorted((left, right) => left.localeCompare(right)),
    files: orderedFiles,
  };
}

function prunePackageFiles(packageRoot: string, retained: ReadonlySet<string>): void {
  const visit = (relative = "") => {
    const current = path.join(packageRoot, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = normalizeRelative(path.join(relative, entry.name));
      if (child === "node_modules" || child.startsWith("node_modules/")) {
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(child);
        if (fs.readdirSync(path.join(packageRoot, child)).length === 0) {
          fs.rmdirSync(path.join(packageRoot, child));
        }
      } else if (child !== "package.json" && !retained.has(child)) {
        fs.rmSync(path.join(packageRoot, child));
      }
    }
  };
  visit();
}

function dependencySpec(
  packageRoot: string,
  manifest: PackageManifest,
  name: string,
): string | null {
  const declared = manifest.dependencies?.[name] ?? manifest.optionalDependencies?.[name];
  if (declared) {
    return declared;
  }
  const installedRoot = path.join(packageRoot, "node_modules", name);
  if (!fs.existsSync(path.join(installedRoot, "package.json"))) {
    // Optional runtime probes may name development-only packages. A production
    // install proves they are not part of this worker's available closure.
    return null;
  }
  const installedManifest = readManifest(installedRoot);
  if (!installedManifest.version) {
    throw new Error(`Mac worker dependency has no installed version: ${name}`);
  }
  return installedManifest.version;
}

function pruneMacNodeWorker(runtime: string): void {
  const resolvedRuntime = fs.realpathSync(runtime);
  const packageRoot = path.join(resolvedRuntime, "lib/node_modules/openclaw");
  if (fs.realpathSync(packageRoot) !== packageRoot || path.basename(packageRoot) !== "openclaw") {
    throw new Error("Mac worker package root is not a canonical installed package");
  }
  const manifest = readManifest(packageRoot);
  const node = path.join(resolvedRuntime, "bin/node");
  const plan = planMacNodeWorkerClosure(packageRoot, node);
  const dependencies = Object.fromEntries(
    plan.dependencies
      .filter((name) => !REQUIRED_OPTIONAL_DEPENDENCIES.includes(name as "sqlite-vec"))
      .flatMap((name) => {
        const spec = dependencySpec(packageRoot, manifest, name);
        return spec ? [[name, spec]] : [];
      }),
  );
  const optionalDependencies = Object.fromEntries(
    REQUIRED_OPTIONAL_DEPENDENCIES.flatMap((name) => {
      const spec = dependencySpec(packageRoot, manifest, name);
      return spec ? [[name, spec]] : [];
    }),
  );
  const exports = Object.fromEntries(
    Object.entries(manifest.exports ?? {}).filter(([name]) => name.startsWith("./plugin-sdk/")),
  );
  prunePackageFiles(packageRoot, new Set(plan.files));
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        type: manifest.type,
        openclaw: manifest.openclaw,
        exports,
        dependencies,
        optionalDependencies,
      },
      null,
      2,
    )}\n`,
  );
  const npm = path.join(resolvedRuntime, "lib/node_modules/npm/bin/npm-cli.js");
  const result = spawnSync(
    node,
    [
      npm,
      "prune",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`Mac worker dependency prune failed:\n${result.stderr || result.stdout}`);
  }
  fs.rmSync(path.join(packageRoot, "package-lock.json"), { force: true });
  const cliWrapper = path.join(resolvedRuntime, "bin/openclaw");
  const cliWrapperInfo = fs.lstatSync(cliWrapper, { throwIfNoEntry: false });
  if (cliWrapperInfo) {
    if (!cliWrapperInfo.isSymbolicLink()) {
      throw new Error("Mac worker CLI wrapper is not the expected installation symlink");
    }
    fs.unlinkSync(cliWrapper);
  }
  process.stderr.write(
    `Pruned Mac worker package to ${plan.files.length} files and ${Object.keys(dependencies).length + Object.keys(optionalDependencies).length} direct dependencies\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = process.argv[2];
  if (!runtime || process.argv.length !== 3) {
    throw new Error("Usage: prune-mac-node-worker.ts <installed-node-runtime>");
  }
  pruneMacNodeWorker(runtime);
}
