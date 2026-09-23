// Builds and validates static assets needed by package-local plugin runtime output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePackageStaticAssetEntries } from "./static-extension-assets.mts";

type PluginRuntimeAssetPlan = {
  packageDir: string;
  packageJson: Record<string, unknown> & { openclaw?: { assetScripts?: { build?: unknown } } };
  pluginDir: string;
};

function resolvePackageAssetBuildCommand(packageJson: PluginRuntimeAssetPlan["packageJson"]) {
  const command = packageJson?.openclaw?.assetScripts?.build;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

function runPackageAssetBuild(plan: PluginRuntimeAssetPlan) {
  const command = resolvePackageAssetBuildCommand(plan.packageJson);
  if (!command) {
    return null;
  }
  console.error(`[plugin-npm-runtime-build] build assets ${plan.pluginDir}: ${command}`);
  const result = spawnSync(command, {
    cwd: plan.packageDir,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${plan.pluginDir} asset build failed: ${command}`);
  }
  return command;
}

/** Uses the selected manifest so private source packages need no Git discovery. */
export function preparePackageRuntimeAssets(plan: PluginRuntimeAssetPlan) {
  const assetBuildCommand = runPackageAssetBuild(plan);
  const assets = resolvePackageStaticAssetEntries(plan.packageJson);
  const missing = assets
    .filter(({ source }) => !fs.existsSync(path.join(plan.packageDir, source)))
    .map(({ source }) => path.posix.join("extensions", plan.pluginDir, source))
    .toSorted((left, right) => left.localeCompare(right));
  if (missing.length > 0) {
    throw new Error(`${plan.pluginDir} missing static asset source(s): ${missing.join(", ")}`);
  }
  const copiedStaticAssets = assets.map(({ source, output }) => {
    const destination = path.join(plan.packageDir, "dist", output);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(plan.packageDir, source), destination);
    return path.posix.join("dist", output);
  });
  return {
    assetBuildCommand,
    copiedStaticAssets: copiedStaticAssets.toSorted((left, right) => left.localeCompare(right)),
  };
}
