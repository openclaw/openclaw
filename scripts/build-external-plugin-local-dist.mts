#!/usr/bin/env node
// Builds source-checkout runtime output for externally published first-party plugins.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { collectSourceCheckoutPluginBuildEntries } from "./lib/bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { buildPluginNpmRuntime } from "./lib/plugin-npm-runtime-build.mts";

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

  for (const packageDir of packageDirs) {
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
    const targetDir = path.join(repoRoot, "dist", "extensions", result.pluginDir);
    assertRealOutputRoot(targetDir);
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
