// Release-time validation layered on the production support-policy parser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadExtendedStablePluginSupport,
  parseExtendedStablePluginSupport,
  EXTENDED_STABLE_PLUGIN_SUPPORT_PATH,
  type ExtendedStablePluginSupport,
  type ExtendedStablePluginSupportEntry,
} from "../../src/plugins/extended-stable-plugin-support.js";

export {
  loadExtendedStablePluginSupport,
  parseExtendedStablePluginSupport,
  EXTENDED_STABLE_PLUGIN_SUPPORT_PATH,
  type ExtendedStablePluginSupport,
  type ExtendedStablePluginSupportEntry,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateExtendedStablePluginPackages(params: {
  rootDir: string;
  targetVersion: string;
  support?: ExtendedStablePluginSupport;
}): ExtendedStablePluginSupport {
  const support = params.support ?? loadExtendedStablePluginSupport(params.rootDir);
  for (const entry of support.plugins) {
    const packagePath = join(params.rootDir, entry.packageDir, "package.json");
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read covered plugin package ${packagePath}: ${String(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(packageJson)) {
      throw new Error(`Covered plugin package ${packagePath} must be a JSON object.`);
    }
    if (packageJson.name !== entry.packageName) {
      throw new Error(
        `Covered plugin ${entry.pluginId} package name must be ${entry.packageName}; found ${String(packageJson.name)}.`,
      );
    }
    if (packageJson.version !== params.targetVersion) {
      throw new Error(
        `Covered plugin ${entry.packageName} version must match root version ${params.targetVersion}; found ${String(packageJson.version)}.`,
      );
    }
  }
  return support;
}
