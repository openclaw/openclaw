#!/usr/bin/env node
/**
 * Patches gaxios to prefer globalThis.fetch (Node.js 18+ native) over
 * dynamic import('node-fetch'), which crashes Node.js v22+ ESM loader.
 *
 * See: https://github.com/openclaw/openclaw/issues/32245
 * Fix: https://github.com/googleapis/gaxios/issues/<upstream>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let gaxiosPath;
try {
  gaxiosPath = require.resolve("gaxios/build/cjs/src/gaxios.js");
} catch {
  console.log("[patch-gaxios] gaxios not found, skipping.");
  process.exit(0);
}

const content = fs.readFileSync(gaxiosPath, "utf8");

const BROKEN = ": (await import('node-fetch')).default;";
const FIXED =
  ": (typeof globalThis.fetch === 'function' ? globalThis.fetch : (await import('node-fetch')).default);";

if (content.includes(FIXED)) {
  console.log("[patch-gaxios] Already patched, skipping.");
  process.exit(0);
}

if (!content.includes(BROKEN)) {
  console.log("[patch-gaxios] Pattern not found — gaxios may have been updated. Skipping.");
  process.exit(0);
}

const patched = content.replace(BROKEN, FIXED);
fs.writeFileSync(gaxiosPath, patched, "utf8");
console.log("[patch-gaxios] ✅ Patched gaxios to use globalThis.fetch on Node.js 18+.");
