#!/usr/bin/env node
// Generates a pre-resolved config cache at build time.
// Phase 3: skips 11 of 13 serial config phases on startup.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIST_CONFIG_CACHE_JSON = "dist/.config-cache.json";
const DIST_CONFIG_CACHE_LLM = "dist/.config-cache.llm";
const DIST_CONFIG_CACHE_MACHINE = "dist/.config-cache.machine";
const DX_SERIALIZER_BIN = path.resolve(
  process.cwd(),
  "..",
  "serializer",
  "target",
  "release",
  "dx-serializer.exe",
);

async function generateConfigCache() {
  const rootDir = process.cwd();
  const distDir = path.join(rootDir, "dist");

  if (!fs.existsSync(distDir)) {
    console.error("[config-cache] dist/ not found. Run build first.");
    process.exit(1);
  }

  // Build the default config baseline by collecting metadata from dist
  const cache = {
    version: 2,
    generatedAt: Date.now(),
    openclawVersion: readPackageVersion(rootDir),
    // Snapshot of bundled channel config schemas + default config values
    // This mirrors what the 13-phase pipeline produces for a fresh install
    // without a user-provided openclaw.json
    defaults: {
      channels: collectBundledChannelDefaults(distDir),
      plugins: collectPluginDefaults(distDir),
    },
    // File content hashes for staleness detection
    sourceHashes: {
      packageJson: hashFile(path.join(rootDir, "package.json")),
      tsdownConfig: hashFile(path.join(rootDir, "tsdown.config.ts")),
    },
  };

  const jsonPath = path.join(rootDir, DIST_CONFIG_CACHE_JSON);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(cache, null, 2), "utf8");
  console.error(`[config-cache] wrote to ${jsonPath}`);

  // Convert to .machine format using dx-serializer if available
  if (fs.existsSync(DX_SERIALIZER_BIN)) {
    const machinePath = path.join(rootDir, DIST_CONFIG_CACHE_MACHINE);
    const result = spawnSync(
      DX_SERIALIZER_BIN,
      [jsonPath, "--output-dir", distDir, "--machine-only"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", cwd: rootDir },
    );
    if (result.status === 0) {
      console.error(`[config-cache] wrote .machine to ${machinePath}`);
    } else {
      console.error(`[config-cache] dx-serializer failed: ${result.stderr?.trim() ?? "error"}`);
    }
  }
}

function readPackageVersion(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function collectBundledChannelDefaults(distDir) {
  const channels = {};
  const extensionsDir = path.join(distDir, "extensions");
  if (!fs.existsSync(extensionsDir)) return channels;

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pluginJsonPath = path.join(extensionsDir, dirent.name, "openclaw.plugin.json");
    if (fs.existsSync(pluginJsonPath)) {
      try {
        const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
        if (plugin.configSchema?.properties) {
          channels[dirent.name] = {
            configSchema: plugin.configSchema,
            defaultConfig: extractDefaultValues(plugin.configSchema),
          };
        }
      } catch {
        // skip invalid manifests
      }
    }
  }
  return channels;
}

function collectPluginDefaults(distDir) {
  const plugins = [];
  const extensionsDir = path.join(distDir, "extensions");
  if (!fs.existsSync(extensionsDir)) return plugins;

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const packageJsonPath = path.join(extensionsDir, dirent.name, "package.json");
    const pluginJsonPath = path.join(extensionsDir, dirent.name, "openclaw.plugin.json");
    const manifestPath = fs.existsSync(pluginJsonPath) ? pluginJsonPath : packageJsonPath;
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        plugins.push({
          id: dirent.name,
          name: manifest.name ?? manifest.displayName ?? dirent.name,
          version: manifest.version,
          description: manifest.description,
        });
      } catch {
        // skip invalid manifests
      }
    }
  }
  return plugins;
}

function extractDefaultValues(schema, path = "") {
  const defaults = {};
  if (!schema || !schema.properties) return defaults;
  for (const [key, value] of Object.entries(schema.properties)) {
    if (value.default !== undefined) {
      defaults[key] = value.default;
    }
    if (value.properties) {
      const nested = extractDefaultValues(value, `${path}.${key}`);
      if (Object.keys(nested).length > 0) {
        defaults[key] = nested;
      }
    }
  }
  return defaults;
}

function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

generateConfigCache().catch((err) => {
  console.error("[config-cache] failed:", err);
  process.exit(1);
});
