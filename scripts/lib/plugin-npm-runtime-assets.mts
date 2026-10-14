// Builds and validates static assets needed by package-local plugin runtime output.
import fs from "node:fs";
import path from "node:path";
import { runPluginAssetCommand } from "./plugin-asset-command.mts";
import {
  resolvePackageStaticAssetEntries,
  resolvePackageStaticAssetSource,
} from "./static-extension-assets.mts";

type PluginRuntimeAssetPlan = {
  packageDir: string;
  packageJson: Record<string, unknown> & { openclaw?: { assetScripts?: { build?: unknown } } };
  pluginDir: string;
};

function resolvePackageAssetBuildCommand(packageJson: PluginRuntimeAssetPlan["packageJson"]) {
  const command = packageJson?.openclaw?.assetScripts?.build;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

async function runPackageAssetBuild(plan: PluginRuntimeAssetPlan) {
  const command = resolvePackageAssetBuildCommand(plan.packageJson);
  if (!command) {
    return null;
  }
  console.error(`[plugin-npm-runtime-build] build assets ${plan.pluginDir}: ${command}`);
  const status = await runPluginAssetCommand({
    command,
    cwd: plan.packageDir,
    pluginId: plan.pluginDir,
    phase: "build",
  });
  if (status !== 0) {
    throw new Error(`${plan.pluginDir} asset build failed: ${command}`);
  }
  return command;
}

/** Uses the selected manifest so private source packages need no Git discovery. */
export async function preparePackageRuntimeAssets(plan: PluginRuntimeAssetPlan) {
  const assetBuildCommand = await runPackageAssetBuild(plan);
  const assets = resolvePackageStaticAssetEntries(plan.packageJson).map(({ source, output }) => ({
    source,
    output,
    srcPath: resolvePackageStaticAssetSource(plan.packageDir, source),
  }));
  const missing = assets
    .filter(({ srcPath }) => !fs.existsSync(srcPath))
    .map(({ source }) => path.posix.join("extensions", plan.pluginDir, source))
    .toSorted((left, right) => left.localeCompare(right));
  if (missing.length > 0) {
    throw new Error(`${plan.pluginDir} missing static asset source(s): ${missing.join(", ")}`);
  }
  const copiedStaticAssets = assets.map(({ srcPath, output }) => {
    const destination = path.join(plan.packageDir, "dist", output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(srcPath, destination);
    return path.posix.join("dist", output);
  });
  return {
    assetBuildCommand,
    copiedStaticAssets: copiedStaticAssets.toSorted((left, right) => left.localeCompare(right)),
  };
}
