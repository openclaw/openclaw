#!/usr/bin/env node
// Builds a single-tarball candidate for harnesses that can install only one
// local package (the Windows-node WSL setup pipeline). Release-shaped
// candidates keep core dependencies such as @openclaw/ai unbundled because
// those publish alongside core; before publication, the verified prepublish
// registry is the only source of those exact versions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import corePackages from "./lib/npm-core-release-packages.json" with { type: "json" };
import { validateBundledPackageDependencyAlignment } from "./package-source-dependencies.mjs";
import { PREPUBLISH_PLUGIN_REGISTRY_MANIFEST } from "./prepublish-plugin-registry-artifact.mjs";

const CANDIDATE_TARBALL = "openclaw-current.tgz";
const CANDIDATE_METADATA = "package-candidate.json";
const CORE_DEPENDENCIES = corePackages.flatMap((entry) => (entry.dependency ? [entry.name] : []));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Bundles unpublished core dependencies from a verified prepublish registry into
 * the candidate tarball. Without a registry, or when nothing needs bundling,
 * the candidate passes through unchanged.
 *
 * @param {{ packageDir: string, registryDir?: string, outputDir: string }} params
 * @returns {{ bundled: string[], sha256: string, version: string }}
 */
export function createSelfContainedCandidatePackage({ packageDir, registryDir, outputDir }) {
  const metadata = readJson(path.join(packageDir, CANDIDATE_METADATA));
  const sourceTarball = path.join(packageDir, CANDIDATE_TARBALL);
  const outputTarball = path.join(outputDir, CANDIDATE_TARBALL);
  fs.mkdirSync(outputDir, { recursive: true });

  const registry = registryDir
    ? readJson(path.join(registryDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST))
    : { packages: [] };
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-self-contained-"));
  const bundled = [];
  try {
    execFileSync("tar", ["-xzf", sourceTarball, "-C", stageDir]);
    const packageRoot = path.join(stageDir, "package");
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = readJson(packageJsonPath);
    const bundleDependencies = packageJson.bundleDependencies ?? [];
    if (!Array.isArray(bundleDependencies)) {
      throw new Error("candidate bundleDependencies must be an array when present");
    }
    for (const name of CORE_DEPENDENCIES) {
      const version = packageJson.dependencies?.[name];
      if (version === undefined || bundleDependencies.includes(name)) {
        continue;
      }
      const entry = registry.packages.find(
        (candidate) => candidate.name === name && candidate.version === version,
      );
      if (!entry) {
        continue;
      }
      const dependencyRoot = path.join(packageRoot, "node_modules", ...name.split("/"));
      fs.mkdirSync(dependencyRoot, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        path.join(registryDir, entry.tarball),
        "-C",
        dependencyRoot,
        "--strip-components=1",
      ]);
      // Root already declares these exact versions; dropping them from the bundled
      // copy keeps npm from resolving a second tree under the bundled package.
      const dependencyJsonPath = path.join(dependencyRoot, "package.json");
      const dependencyJson = readJson(dependencyJsonPath);
      validateBundledPackageDependencyAlignment({
        bundledDependencies: dependencyJson.dependencies,
        bundledPackageLabel: `${name}@${version}`,
        rootDependencies: packageJson.dependencies,
      });
      delete dependencyJson.dependencies;
      writeJson(dependencyJsonPath, dependencyJson);
      bundleDependencies.push(name);
      bundled.push(name);
    }
    if (bundled.length === 0) {
      fs.copyFileSync(sourceTarball, outputTarball);
    } else {
      packageJson.bundleDependencies = bundleDependencies;
      writeJson(packageJsonPath, packageJson);
      execFileSync("tar", ["--no-xattrs", "-czf", outputTarball, "-C", stageDir, "package"]);
    }
  } finally {
    fs.rmSync(stageDir, { force: true, recursive: true });
  }
  const sha256 = sha256File(outputTarball);
  writeJson(path.join(outputDir, CANDIDATE_METADATA), { ...metadata, sha256 });
  return { bundled, sha256, version: metadata.version };
}

function main() {
  const args = process.argv.slice(2);
  const options = new Map();
  while (args.length > 0) {
    const name = args.shift();
    const value = args.shift();
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument list near ${String(name)}`);
    }
    options.set(name, value);
  }
  const packageDir = options.get("--package-dir");
  const outputDir = options.get("--output-dir");
  if (!packageDir || !outputDir) {
    throw new Error(
      "usage: self-contained-candidate-package.mjs --package-dir <dir> --output-dir <dir> [--registry-dir <dir>]",
    );
  }
  const result = createSelfContainedCandidatePackage({
    packageDir,
    outputDir,
    registryDir: options.get("--registry-dir") || undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
