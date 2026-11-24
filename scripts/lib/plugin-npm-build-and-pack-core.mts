import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveNpmRunner } from "../npm-runner.mts";
import { withAugmentedPluginNpmManifestForPackage } from "./plugin-npm-package-manifest.mts";
import { buildPluginNpmRuntime } from "./plugin-npm-runtime-build.mts";

export async function buildAndPackPlugin(packageDir: string, outputDir: string): Promise<number> {
  const built = await buildPluginNpmRuntime({ packageDir });
  if (built) {
    console.error(
      `[plugin-npm-runtime-build] built ${built.pluginDir} runtime (${built.sourceEntries.length} entries)`,
    );
  }
  return withAugmentedPluginNpmManifestForPackage(
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
}
