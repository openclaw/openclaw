#!/usr/bin/env node

/**
 * Verifies that the root plugin-sdk runtime surface and generated facade types
 * are present in the compiled dist output.
 *
 * Run after `pnpm build` to catch missing root exports or leaked repo-only type
 * aliases before release.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSdkSubpaths } from "./lib/plugin-sdk-entries.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = resolve(__dirname, "..", "dist", "plugin-sdk", "index.js");
const generatedFacadeTypeMapDts = resolve(
  __dirname,
  "..",
  "dist",
  "plugin-sdk",
  "src",
  "generated",
  "plugin-sdk-facade-type-map.generated.d.ts",
);

if (!existsSync(distFile)) {
  console.error("ERROR: dist/plugin-sdk/index.js not found. Run `pnpm build` first.");
  process.exit(1);
}

const content = readFileSync(distFile, "utf-8");

// Extract the final export statement from the compiled output.
// tsdown/rolldown emits a single `export { ... }` at the end of the file.
const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
if (!exportMatch) {
  console.error("ERROR: Could not find export statement in dist/plugin-sdk/index.js");
  process.exit(1);
}

const exportedNames = exportMatch[1]
  .split(",")
  .map((s) => {
    // Handle `foo as bar` aliases — the exported name is the `bar` part
    const parts = s.trim().split(/\s+as\s+/);
    return (parts[parts.length - 1] || "").trim();
  })
  .filter(Boolean);

const exportSet = new Set(exportedNames);

const requiredRuntimeShimEntries = ["compat.js", "root-alias.cjs"];

// The root plugin-sdk entry intentionally stays tiny. Keep this list aligned
// with src/plugin-sdk/index.ts runtime exports.
const requiredExports = [
  "emptyPluginConfigSchema",
  "onDiagnosticEvent",
  "registerContextEngine",
  "delegateCompactionToRuntime",
];

let missing = 0;
for (const name of requiredExports) {
  if (!exportSet.has(name)) {
    console.error(`MISSING EXPORT: ${name}`);
    missing += 1;
  }
}

/**
 * Extract runtime (non-type) export names from a plugin-sdk source file.
 * Parses `export { ... } from "..."` blocks and filters out `type` exports.
 */
function extractSourceExportNames(sourcePath) {
  if (!existsSync(sourcePath)) {
    return null;
  }
  const src = readFileSync(sourcePath, "utf-8");
  const names = [];
  // Match `export { a, b, type C } from "..."` blocks
  for (const match of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g)) {
    for (const item of match[1].split(",")) {
      const trimmed = item.trim();
      // Skip type-only exports
      if (trimmed.startsWith("type ")) {
        continue;
      }
      // Handle `foo as bar` — the exported name is `bar`
      const parts = trimmed.split(/\s+as\s+/);
      const name = (parts[parts.length - 1] || "").trim();
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Extract exported names from a compiled dist JS file.
 */
function extractDistExportNames(distPath) {
  const content = readFileSync(distPath, "utf-8");
  const match = content.match(/export\s*\{([^}]+)\}/);
  if (!match) {
    return new Set();
  }
  return new Set(
    match[1]
      .split(",")
      .map((s) => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[parts.length - 1] || "").trim();
      })
      .filter(Boolean),
  );
}

for (const entry of pluginSdkSubpaths) {
  const jsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.js`);
  const dtsPath = resolve(__dirname, "..", "dist", "plugin-sdk", `${entry}.d.ts`);
  if (!existsSync(jsPath)) {
    console.error(`MISSING SUBPATH JS: dist/plugin-sdk/${entry}.js`);
    missing += 1;
  }
  if (!existsSync(dtsPath)) {
    console.error(`MISSING SUBPATH DTS: dist/plugin-sdk/${entry}.d.ts`);
    missing += 1;
  }

  // Verify that every runtime export in the source is present in the dist.
  if (existsSync(jsPath)) {
    const sourcePath = resolve(__dirname, "..", "src", "plugin-sdk", `${entry}.ts`);
    const sourceNames = extractSourceExportNames(sourcePath);
    if (sourceNames && sourceNames.length > 0) {
      const distNames = extractDistExportNames(jsPath);
      for (const name of sourceNames) {
        if (!distNames.has(name)) {
          console.error(
            `MISSING SUBPATH EXPORT: dist/plugin-sdk/${entry}.js is missing "${name}" (present in source)`,
          );
          missing += 1;
        }
      }
    }
  }
}

for (const entry of requiredRuntimeShimEntries) {
  const shimPath = resolve(__dirname, "..", "dist", "plugin-sdk", entry);
  if (!existsSync(shimPath)) {
    console.error(`MISSING RUNTIME SHIM: dist/plugin-sdk/${entry}`);
    missing += 1;
  }
}

if (!existsSync(generatedFacadeTypeMapDts)) {
  console.error(
    "MISSING GENERATED FACADE TYPE MAP DTS: dist/plugin-sdk/src/generated/plugin-sdk-facade-type-map.generated.d.ts",
  );
  missing += 1;
} else {
  const facadeTypeMapContent = readFileSync(generatedFacadeTypeMapDts, "utf-8");
  if (facadeTypeMapContent.includes("@openclaw/")) {
    console.error(
      "INVALID GENERATED FACADE TYPE MAP DTS: dist/plugin-sdk/src/generated/plugin-sdk-facade-type-map.generated.d.ts leaks @openclaw/* imports",
    );
    missing += 1;
  }
}

if (missing > 0) {
  console.error(
    `\nERROR: ${missing} required plugin-sdk artifact(s) missing (named exports or subpath files).`,
  );
  console.error("This will break published plugin-sdk artifacts.");
  console.error(
    "Check src/plugin-sdk/index.ts, generated d.ts rewrites, subpath entries, and rebuild.",
  );
  process.exit(1);
}

console.log(
  `OK: All ${requiredExports.length} required root exports and ${pluginSdkSubpaths.length} subpath entries verified.`,
);
