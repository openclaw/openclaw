#!/usr/bin/env node

/**
 * Postinstall patch for gaxios — prefer globalThis.fetch over dynamic
 * `import('node-fetch')` to avoid `Cannot convert undefined or null to object`
 * crashes on Node 22+/24+/25 when the native fetch is available.
 *
 * See: openclaw/openclaw#32245, openclaw/openclaw#33392
 *
 * Co-authored-by: cgdusek
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const BROKEN_IMPORT_PATTERNS = [
  ": (await import('node-fetch')).default;",
  ': (await import("node-fetch")).default;',
];
const FIXED_IMPORT =
  ": (typeof globalThis.fetch === 'function' ? globalThis.fetch : (await import('node-fetch')).default);";

function resolveGaxiosRoot() {
  try {
    const gaxiosEntry = require.resolve("gaxios");
    return path.resolve(path.dirname(gaxiosEntry), "../../..");
  } catch {
    return null;
  }
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes("typeof globalThis.fetch === 'function'")) {
    return "already";
  }

  for (const brokenPattern of BROKEN_IMPORT_PATTERNS) {
    if (!source.includes(brokenPattern)) {
      continue;
    }
    fs.writeFileSync(filePath, source.replace(brokenPattern, FIXED_IMPORT), "utf8");
    return "patched";
  }

  return "pattern-missing";
}

function run() {
  const root = resolveGaxiosRoot();
  if (!root) {
    console.log("[patch-gaxios-fetch] gaxios not found, skipping.");
    return;
  }

  const files = [
    path.join(root, "build/cjs/src/gaxios.js"),
    path.join(root, "build/esm/src/gaxios.js"),
  ];

  const outcomes = files.map((filePath) => ({ filePath, result: patchFile(filePath) }));
  const patchedCount = outcomes.filter((item) => item.result === "patched").length;

  if (patchedCount > 0) {
    console.log(`[patch-gaxios-fetch] patched ${patchedCount} gaxios runtime file(s).`);
    return;
  }

  const alreadyCount = outcomes.filter((item) => item.result === "already").length;
  if (alreadyCount === outcomes.length) {
    console.log("[patch-gaxios-fetch] already patched.");
    return;
  }

  const details = outcomes
    .map((item) => `${path.basename(item.filePath)}=${item.result}`)
    .join(", ");
  console.log(`[patch-gaxios-fetch] no patch applied (${details}).`);
}

run();
