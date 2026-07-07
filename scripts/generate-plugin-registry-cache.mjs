#!/usr/bin/env node
// Generates a pre-built plugin registry cache (JSON + .machine) at build time.
// Phase 2: replaces runtime filesystem scanning with pre-compiled cache reads.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST_PLUGIN_REGISTRY_JSON = "dist/.plugin-registry.json";
const DIST_PLUGIN_REGISTRY_LLM = "dist/.plugin-registry.llm";
const DIST_PLUGIN_REGISTRY_MACHINE = "dist/.plugin-registry.machine";
const DX_SERIALIZER_BIN = path.resolve(
  process.cwd(),
  "..",
  "serializer",
  "target",
  "release",
  "dx-serializer.exe",
);

async function generatePluginRegistryCache() {
  const rootDir = process.cwd();
  const distDir = path.join(rootDir, "dist");

  if (!fs.existsSync(distDir)) {
    console.error("[plugin-registry-cache] dist/ not found. Run build first.");
    process.exit(1);
  }

  // Scan extensions dir for plugin metadata
  const extensionsDir = path.join(rootDir, "extensions");
  const distExtensionsDir = path.join(distDir, "extensions");
  const candidates = [];

  // Scan dist/extensions/ first (built plugins)
  if (fs.existsSync(distExtensionsDir)) {
    for (const dirent of fs.readdirSync(distExtensionsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const pluginDir = path.join(distExtensionsDir, dirent.name);
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const packageJsonPath = path.join(pluginDir, "package.json");
      if (fs.existsSync(manifestPath)) {
        candidates.push({
          idHint: dirent.name,
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "bundled",
          format: "openclaw",
          manifestPath,
          sourceHash: hashFile(manifestPath),
        });
      } else if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        candidates.push({
          idHint: dirent.name,
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "bundled",
          format: "openclaw",
          packageName: pkg.name,
          packageVersion: pkg.version,
          sourceHash: hashFile(packageJsonPath),
        });
      }
    }
  }

  // Scan extensions/ source dir for source plugins
  if (fs.existsSync(extensionsDir)) {
    for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const pluginDir = path.join(extensionsDir, dirent.name);
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const packageJsonPath = path.join(pluginDir, "package.json");

      if (fs.existsSync(manifestPath)) {
        candidates.push({
          idHint: dirent.name,
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "bundled",
          format: "openclaw",
          manifestPath,
          sourceHash: hashFile(manifestPath),
        });
      } else if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        candidates.push({
          idHint: dirent.name,
          source: path.join(pluginDir, "index.ts"),
          rootDir: pluginDir,
          origin: "bundled",
          format: "openclaw",
          packageName: pkg.name,
          packageVersion: pkg.version,
          sourceHash: hashFile(packageJsonPath),
        });
      }
    }
  }

  // Deduplicate by idHint, preferring dist over source
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    if (!seen.has(c.idHint)) {
      seen.add(c.idHint);
      deduped.push(c);
    }
  }

  const registry = {
    version: 2,
    generatedAt: Date.now(),
    buildCacheVersion: process.env.BUILD_CACHE_VERSION ?? "1",
    candidates: deduped,
  };

  // Write JSON cache
  const jsonPath = path.join(rootDir, DIST_PLUGIN_REGISTRY_JSON);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(registry, null, 2), "utf8");
  console.error(`[plugin-registry-cache] wrote ${deduped.length} candidates to ${jsonPath}`);

  // Convert to .machine format using dx-serializer if available
  if (fs.existsSync(DX_SERIALIZER_BIN)) {
    const llmPath = path.join(rootDir, DIST_PLUGIN_REGISTRY_LLM);
    const machinePath = path.join(rootDir, DIST_PLUGIN_REGISTRY_MACHINE);
    fs.mkdirSync(path.dirname(machinePath), { recursive: true });

    const result = spawnSync(
      DX_SERIALIZER_BIN,
      [jsonPath, "--output-dir", distDir, "--machine-only"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        cwd: rootDir,
      },
    );

    if (result.status === 0) {
      console.error(`[plugin-registry-cache] wrote .machine to ${machinePath}`);
    } else {
      console.error(
        `[plugin-registry-cache] dx-serializer failed: ${result.stderr?.trim() ?? "unknown error"}`,
      );
    }
  } else {
    console.error(
      `[plugin-registry-cache] dx-serializer not found at ${DX_SERIALIZER_BIN}, skipping .machine generation`,
    );
  }
}

function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

generatePluginRegistryCache().catch((err) => {
  console.error("[plugin-registry-cache] failed:", err);
  process.exit(1);
});
