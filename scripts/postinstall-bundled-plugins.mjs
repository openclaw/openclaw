#!/usr/bin/env node
// Runs after `npm i -g` to install runtime deps for bundled extensions
// that cannot be pre-bundled (e.g. platform-specific binaries like acpx).
// All other extension deps are already bundled into dist/ JS files.
// This script is a no-op outside of a global npm install context.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLED_PLUGIN_INSTALL_TARGETS = [
  {
    pluginId: "acpx",
    sentinelPath: join("node_modules", "acpx", "package.json"),
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSIONS_DIR = join(__dirname, "..", "dist", "extensions");

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  if (env.npm_config_global !== "true") {
    return;
  }
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const exec = params.execSync ?? execSync;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;

  for (const target of BUNDLED_PLUGIN_INSTALL_TARGETS) {
    const extDir = join(extensionsDir, target.pluginId);
    if (!pathExists(join(extDir, "package.json"))) {
      continue;
    }
    if (pathExists(join(extDir, target.sentinelPath))) {
      continue;
    }
    try {
      exec("npm install --omit=dev --no-save --package-lock=false", {
        cwd: extDir,
        env: createNestedNpmInstallEnv(env),
        stdio: "pipe",
      });
      log.log(`[postinstall] installed bundled plugin deps: ${target.pluginId}`);
    } catch (e) {
      // Non-fatal: gateway will surface the missing dep via doctor.
      log.warn(`[postinstall] could not install deps for ${target.pluginId}: ${String(e)}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBundledPluginPostinstall();
}
