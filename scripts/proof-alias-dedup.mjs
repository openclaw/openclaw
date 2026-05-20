#!/usr/bin/env node
/**
 * Proof: demonstrates memory dedup across DIFFERENT resolution contexts
 * that produce the SAME alias map content.
 *
 * In production, each of ~24 bundled plugins calls buildPluginLoaderAliasMap
 * with different modulePath values. Without content-based sharing, each
 * produces its own copy of the same ~101 KB alias map. With aliasMapContentCache
 * and normalizedJitiAliasMapCache, they all share one copy.
 *
 * Usage:
 *   pnpm build
 *   node --expose-gc scripts/proof-alias-dedup.mjs
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";

const require = createRequire(import.meta.url);
const {
  buildPluginLoaderJitiOptions,
  buildPluginLoaderAliasMap,
  resolvePluginLoaderModuleConfig,
  normalizeJitiAliasTargetPath,
} = require("../dist/plugins/sdk-alias.js");

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// Collect all bundled plugin entrypoints to simulate production load
function findBundledPluginEntries() {
  const extDir = path.join(process.cwd(), "dist", "extensions");
  if (!fs.existsSync(extDir)) return [];
  return fs
    .readdirSync(extDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const api = path.join(extDir, d.name, "api.js");
      if (fs.existsSync(api)) return api;
      const idx = path.join(extDir, d.name, "index.js");
      if (fs.existsSync(idx)) return idx;
      return null;
    })
    .filter(Boolean);
}

function countUniqueRefs(arr) {
  return new Set(arr).size;
}

function main() {
  // --- Test A: buildPluginLoaderAliasMap with different modulePath ---
  const entries = findBundledPluginEntries();
  console.log(`Bundled plugin entries found: ${entries.length}`);
  if (entries.length < 2) {
    console.log("Need >= 2 bundled plugins (run pnpm build first).");
  }

  const aliasMaps = [];
  for (const entry of entries) {
    const map = buildPluginLoaderAliasMap(entry);
    aliasMaps.push(map);
  }

  const firstMap = aliasMaps[0];
  const mapKeys = Object.keys(firstMap).length;
  const mapShared = aliasMaps.filter((m) => m === firstMap).length;
  const mapUnique = countUniqueRefs(aliasMaps);

  console.log();
  console.log("=== Test A: buildPluginLoaderAliasMap across different plugins ===");
  console.log(`  Plugins:                ${entries.length}`);
  console.log(`  Entries per map:        ${mapKeys}`);
  console.log(`  Same-ref sharing:       ${mapShared} / ${entries.length}`);
  console.log(`  Unique alias maps:      ${mapUnique}`);
  console.log(
    `  Verdict:                ${mapUnique === 1 ? "PASS — content-key dedup" : "FAIL — duplicates"}`,
  );
  if (mapUnique > 1) {
    console.log(
      `  (Without aliasMapContentCache: ${entries.length} copies of ~${Math.round(mapKeys * 0.1)} KB each)`,
    );
  }
  console.log();

  // --- Test B: buildPluginLoaderJitiOptions with different objects ---
  // Simulate loader creating jiti options for each alias map copy
  const jitiResults = [];
  for (const map of aliasMaps) {
    jitiResults.push(buildPluginLoaderJitiOptions({ ...map }).alias);
  }
  const jitiFirst = jitiResults[0];
  const jitiShared = jitiResults.filter((r) => r === jitiFirst).length;
  const jitiUnique = countUniqueRefs(jitiResults);

  console.log("=== Test B: buildPluginLoaderJitiOptions across different source objects ===");
  console.log(`  Source objects:         ${entries.length}`);
  console.log(`  Same-ref sharing:       ${jitiShared} / ${entries.length}`);
  console.log(`  Unique results:         ${jitiUnique}`);
  const marker = Symbol.for("pathe:normalizedAlias");
  console.log(`  Has normalized marker:  ${Boolean(jitiFirst?.[marker])}`);
  console.log(
    `  Verdict:                ${jitiUnique === 1 ? "PASS — content-key jiti dedup" : "FAIL — duplicates"}`,
  );
  if (jitiUnique > 1) {
    console.log(
      `  (Without normalizedJitiAliasMapCache: ${entries.length} copies of ~101 KB each)`,
    );
  }
  console.log();

  // --- Test C: cacheKey dedup across different plugins ---
  const configs = [];
  for (const entry of entries) {
    configs.push(
      resolvePluginLoaderModuleConfig({
        modulePath: entry,
        moduleUrl: `file://${entry}`,
        preferBuiltDist: true,
      }),
    );
  }
  const ckFirst = configs[0].cacheKey;
  const ckShared = configs.filter((c) => c.cacheKey === ckFirst).length;
  const ckUnique = countUniqueRefs(configs.map((c) => c.cacheKey));
  const ckLen = ckFirst.length;

  console.log("=== Test C: cacheKey string dedup across different plugins ===");
  console.log(`  Plugins:                ${entries.length}`);
  console.log(`  cacheKey size each:     ${formatBytes(ckLen)}`);
  console.log(`  Same-ref sharing:       ${ckShared} / ${entries.length}`);
  console.log(`  Unique cacheKeys:       ${ckUnique}`);
  console.log(`  Est. savings:           ${formatBytes((entries.length - ckUnique) * ckLen)}`);
  console.log(
    `  Verdict:                ${ckUnique === 1 ? "PASS — cacheKey reuse" : "FAIL — duplicates (pre-attach missing)"}`,
  );
  console.log();

  if (typeof gc === "function") gc();
  const snapshot = writeHeapSnapshot();
  console.log(`Heap snapshot: ${snapshot}`);
  console.log("Open in Chrome DevTools > Memory > Load. Search 'plugin-sdk'.");
  console.log("With fix: identical strings shared across all plugins' alias maps.");
  console.log();
  console.log("=== Comparison steps ===");
  console.log("# 1. On broken patch (f6d6e80804):");
  console.log("#    git checkout f6d6e80804 -- src/plugins/sdk-alias.ts && pnpm build");
  console.log("#    node --expose-gc scripts/proof-alias-dedup.mjs");
  console.log("#    Expected: Unique alias maps > 1, Unique results > 1, Unique cacheKeys > 1");
  console.log();
  console.log("# 2. On fixed patch (current):");
  console.log("#    git checkout dev-enhance2 -- src/plugins/sdk-alias.ts && pnpm build");
  console.log("#    node --expose-gc scripts/proof-alias-dedup.mjs");
  console.log("#    Expected: Unique alias maps = 1, Unique results = 1, Unique cacheKeys = 1");
}

main();
