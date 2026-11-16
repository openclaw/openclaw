// Build and package one plugin in a shared module lifetime.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveNpmRunner } from "../npm-runner.mts";
import { withAugmentedPluginNpmManifestForPackage } from "./plugin-npm-package-manifest.mts";
import { buildPluginNpmRuntime } from "./plugin-npm-runtime-build.mts";

try {
  const [packageDir, outputDir, extra] = process.argv.slice(2);
  if (!packageDir || !outputDir || extra !== undefined) {
    throw new Error("usage: plugin-npm-build-and-pack.mts <package-dir> <output-dir>");
  }
  const built = await buildPluginNpmRuntime({ packageDir });
  if (built) {
    console.error(
      `[plugin-npm-runtime-build] built ${built.pluginDir} runtime (${built.sourceEntries.length} entries)`,
    );
  }
  process.exitCode = withAugmentedPluginNpmManifestForPackage(
    { packageDir, bundleDependencies: process.env.OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES },
    ({ packageDir: cwd }) => {
      const invocation = resolveNpmRunner({
        npmArgs: [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          path.resolve(outputDir),
        ],
      });
      const result = spawnSync(invocation.command, invocation.args, {
        cwd,
        env: invocation.env ?? process.env,
        stdio: "inherit",
        shell: invocation.shell,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      if (result.error) {
        throw result.error;
      }
      return result.status ?? 1;
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
