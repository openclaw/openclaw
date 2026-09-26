// Standalone package builds share the root build's entry and declaration ownership.
import fs from "node:fs";
import path from "node:path";
import type { InlineConfig, PackageJsonWithPath, UserConfig } from "tsdown";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { tsdownPackageOutputRoot } from "./lib/tsdown-output-roots.mts";
import { cleanTsdownOutputRoots, sanitizeTsdownBuildOutputRoots } from "./tsdown-build.mts";

export function selectWorkspacePackageBuildConfig(
  configs: UserConfig[],
  packageName: string,
  target: string | false,
): InlineConfig {
  const outDir = tsdownPackageOutputRoot(packageName);
  const selected = configs.filter((config) => config.outDir === outDir);
  if (selected.length !== 1) {
    throw new Error(`Expected one build config for ${packageName}; found ${selected.length}`);
  }
  return {
    ...selected[0],
    config: false,
    clean: false,
    dts: true,
    platform: "node",
    format: "esm",
    target,
    concurrency: 1,
    // Application folding and dependency policy do not belong to standalone libraries.
    env: {},
    deps: {},
    inputOptions: undefined,
  };
}

export async function buildWorkspacePackage(packageName: string) {
  const root = resolveRepoRoot(import.meta.url);
  const output = tsdownPackageOutputRoot(packageName);
  const packageJsonPath = path.join(root, "packages", packageName, "package.json");
  const manifest: PackageJsonWithPath = {
    ...JSON.parse(fs.readFileSync(packageJsonPath, "utf8")),
    packageJsonPath,
  };
  const { minVersion } = await import("semver");
  const nodeEngine = manifest.engines?.node;
  const nodeVersion = nodeEngine ? minVersion(nodeEngine) : null;
  if (nodeEngine && !nodeVersion) {
    throw new Error(`Invalid Node engine for ${packageName}`);
  }
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    // The canonical config reads manifests relative to the repository root.
    const { default: configs } = await import("../tsdown.config.ts");
    const config = selectWorkspacePackageBuildConfig(
      configs,
      packageName,
      // No engine means no transformation, as in the package-local tsdown CLI.
      nodeVersion ? `node${nodeVersion.version}` : false,
    );
    const canonicalHooks = config.hooks;
    config.hooks = async (hooks) => {
      if (typeof canonicalHooks === "function") {
        await canonicalHooks(hooks);
      } else if (canonicalHooks) {
        hooks.addHooks(canonicalHooks);
      }
      // tsdown indexes package completion before this hook, but creates dependency
      // plugins afterward. Preserve its coordinator identity while supplying the
      // standalone library's metadata to its native dependency-policy owner.
      hooks.hook("build:prepare", ({ options }) => {
        if (!options.pkg) {
          throw new Error("Missing build package metadata");
        }
        options.pkg.dependencies = manifest.dependencies;
        options.pkg.peerDependencies = manifest.peerDependencies;
        options.pkg.peerDependenciesMeta = manifest.peerDependenciesMeta;
        options.pkg.optionalDependencies = manifest.optionalDependencies;
      });
    };
    await withDistArtifactOwnership(root, async () => {
      cleanTsdownOutputRoots({
        cwd: root,
        roots: [output],
        env: { ...process.env, OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
      });
      const { build } = await import("tsdown");
      const { bundles } = await build({ ...config, cwd: root });
      try {
        sanitizeTsdownBuildOutputRoots(["--out-dir", output], root);
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    });
  } finally {
    process.chdir(previousCwd);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const [packageName, ...extra] = process.argv.slice(2);
  if (!packageName || extra.length) {
    throw new Error("Expected one workspace package name");
  }
  await buildWorkspacePackage(packageName);
}
