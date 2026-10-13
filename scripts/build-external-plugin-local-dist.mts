#!/usr/bin/env node
// Builds source-checkout runtime output for externally published first-party plugins.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  finalizeBuildStepCache,
  hashInputFiles,
  listCacheFiles,
  resolveBuildStepCacheState,
  resolveTsdownCompilerIdentity,
  restoreBuildStepCacheOutputs,
  type BuildCacheStep,
} from "./lib/build-artifact-cache.mts";
import { collectSourceCheckoutPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import {
  buildPluginNpmRuntime,
  resolvePluginNpmRuntimeBuildPlan,
} from "./lib/plugin-npm-runtime-build.mts";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";

type ExternalPluginLocalDistParams = {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  logLevel?: "silent" | "warn";
};

/** Lists external first-party packages that need source-checkout dist output. */
export function listExternalPluginLocalDistPackageDirs(
  params: Pick<ExternalPluginLocalDistParams, "repoRoot" | "env"> = {},
): string[] {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  return collectSourceCheckoutPluginBuildEntries({ cwd: repoRoot, env: params.env })
    .filter(({ isolated }) => isolated)
    .map(({ id }) => `extensions/${id}`);
}

/** Builds isolated plugin graphs and stages their Node runtime output. */
export async function buildExternalPluginLocalDist(
  params: ExternalPluginLocalDistParams = {},
): Promise<{ durationMs: number; pluginDirs: string[] }> {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDirs = listExternalPluginLocalDistPackageDirs({
    repoRoot,
    env: params.env,
  });
  const startedAt = performance.now();
  const pluginDirs: string[] = [];
  const generatedAssets = listGeneratedExtensionAssetSources({ rootDir: repoRoot });
  const env = params.env ?? process.env;
  const cacheEnabled = env.OPENCLAW_BUILD_CACHE !== "0";
  const sharedSignature = cacheEnabled
    ? hashInputFiles(
        repoRoot,
        listCacheFiles(
          repoRoot,
          [
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "tsconfig.json",
            "patches",
            "scripts/build-external-plugin-local-dist.mts",
            "scripts/lib",
            "src/plugins/package-entrypoints.ts",
            "src/plugins/portable-icon-paths.ts",
            "src/shared/non-packaged-plugin-dirs.ts",
          ],
          fs,
        ),
        fs,
        ["NODE_ENV", "SOURCE_DATE_EPOCH"],
        env,
        resolveTsdownCompilerIdentity(),
      )
    : "";

  for (const packageDir of packageDirs) {
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir });
    if (!plan) {
      throw new Error(`${packageDir} did not produce source-checkout runtime output`);
    }
    const target = `dist/extensions/${plan.pluginDir}`;
    const browserOutput = `${packageDir}/dist/control-ui`;
    // Manifest writers run before compilation. Their fresh manifest fingerprints
    // browser dependencies; the runtime cache must not restore over that owner.
    const earlyAssets = generatedAssets.includes(`${packageDir}/openclaw.plugin.json`);
    const sourceOutputs = earlyAssets
      ? []
      : generatedAssets.filter(
          (asset) => asset.startsWith(`${packageDir}/`) && !asset.includes("/node_modules/"),
        );
    const step: BuildCacheStep = {
      label: `tsdown:external-plugin:${plan.pluginDir}`,
      cache: {
        inputs: [
          { path: packageDir, excludeDirectories: ["dist", "node_modules", ".artifacts", ".git"] },
          ...plan.bundledSdkSourceFiles,
        ],
        env: ["NODE_ENV", "SOURCE_DATE_EPOCH"],
        outputs: [target, ...(earlyAssets ? [] : [browserOutput, ...sourceOutputs])],
        requiredOutputs: plan.runtimeBuildOutputs.map((output) =>
          path.posix.join(target, output.replace(/^\.\/dist\//u, "")),
        ),
      },
    };
    const cacheParams = {
      rootDir: repoRoot,
      env,
      inputSignature: (inputs: string[]) => {
        const discoveryRoots = [...new Set(inputs.map((input) => path.dirname(input)))];
        const files = listCacheFiles(
          repoRoot,
          [
            ...step.cache!.inputs,
            ...inputs,
            ...discoveryRoots.map((root) => ({ path: root, recursive: false })),
          ],
          fs,
        );
        const generated = sourceOutputs.map((output) => path.resolve(repoRoot, output));
        return hashInputFiles(
          repoRoot,
          [...new Set(files)]
            .filter(
              (file) =>
                !generated.some(
                  (output) => file === output || file.startsWith(`${output}${path.sep}`),
                ),
            )
            .toSorted(),
          fs,
          step.cache!.env,
          env,
          sharedSignature,
        );
      },
    };
    const cacheState = cacheEnabled ? resolveBuildStepCacheState(step, cacheParams) : undefined;
    const targetDir = path.join(repoRoot, target);
    assertRealOutputRoot(path.join(repoRoot, "dist"));
    assertRealOutputRoot(path.dirname(targetDir));
    assertRealOutputRoot(targetDir);
    if (cacheState?.fresh) {
      if (cacheState.restorable) {
        assertRealOutputRoot(plan.outDir);
        for (const output of sourceOutputs) {
          let current = path.join(repoRoot, output);
          while (current !== path.join(repoRoot, packageDir)) {
            assertRealOutputRoot(current);
            current = path.dirname(current);
          }
        }
        fs.rmSync(targetDir, { recursive: true, force: true });
        if (!earlyAssets) {
          assertRealOutputRoot(path.join(repoRoot, browserOutput));
          fs.rmSync(path.join(repoRoot, browserOutput), { recursive: true, force: true });
        }
        if (!restoreBuildStepCacheOutputs(cacheState, cacheParams)) {
          throw new Error(`${packageDir} cache changed before restoration; rerun the build`);
        }
      }
      pluginDirs.push(plan.pluginDir);
      continue;
    }
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir,
      // Standalone package validation owns its existing bundler warnings; this
      // root build still surfaces errors and validates every emitted host import.
      logLevel: params.logLevel ?? "error",
    });
    if (!result) {
      throw new Error(`${packageDir} did not produce source-checkout runtime output`);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(result.outDir)) {
      // Source-discovered plugins serve these assets in place; plugins:assets:copy
      // also stages them at their manifest-relative path, without flattening dist/.
      if (entry === "control-ui") {
        continue;
      }
      const source = path.join(result.outDir, entry);
      fs.cpSync(source, path.join(targetDir, entry), { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
    if (fs.readdirSync(result.outDir).length === 0) {
      fs.rmdirSync(result.outDir);
    }
    if (cacheState) {
      cacheState.signature = cacheParams.inputSignature(result.inputFiles);
      cacheState.consumedInputs = result.inputFiles;
      finalizeBuildStepCache(step, cacheState, cacheParams);
    }
    pluginDirs.push(result.pluginDir);
  }

  return {
    durationMs: performance.now() - startedAt,
    pluginDirs,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await buildExternalPluginLocalDist();
    console.log(
      `[external-plugin-local-dist] built ${result.pluginDirs.length} plugins in ${Math.round(result.durationMs)}ms`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
