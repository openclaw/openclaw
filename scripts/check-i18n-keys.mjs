#!/usr/bin/env node
/**
 * i18n Key Parity Checker
 *
 * Ensures every locale file exports exactly the same nested key structure
 * as the English reference locale (en.ts). Run this in CI to catch missing
 * or extra translation keys early.
 *
 * Usage:
 *   node scripts/check-i18n-keys.mjs [--fix]
 *
 * Flags:
 *   --fix   Print a stub object for missing keys (copy-paste helper, does not auto-write).
 */

import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

const LOCALES_DIR = join(import.meta.dirname, "..", "ui", "src", "i18n", "locales");
const REFERENCE_LOCALE = "en";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect all dot-separated key paths from a nested object. */
function collectKeys(obj, prefix = "") {
  const keys = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const nested of collectKeys(v, path)) {
        keys.add(nested);
      }
    } else {
      keys.add(path);
    }
  }
  return keys;
}

/** Import a locale .ts file and return its default export or named export. */
async function loadLocale(filePath) {
  const mod = await import(pathToFileURL(filePath).href);
  // Named export matching the filename (e.g. `export const en = { ... }`)
  const name = basename(filePath, ".ts")
    .replace(/-([a-zA-Z])/g, (_, c) => `_${c.toUpperCase()}`)
    .replace(/-/g, "_");
  return mod[name] ?? mod.default ?? Object.values(mod).find((v) => v && typeof v === "object");
}

// ── main ────────────────────────────────────────────────────────────────────

const showFix = process.argv.includes("--fix");

const files = (await readdir(LOCALES_DIR)).filter((f) => f.endsWith(".ts"));
const referenceFile = files.find((f) => f === `${REFERENCE_LOCALE}.ts`);
if (!referenceFile) {
  console.error(`❌ Reference locale file "${REFERENCE_LOCALE}.ts" not found in ${LOCALES_DIR}`);
  process.exit(1);
}

const refMap = await loadLocale(join(LOCALES_DIR, referenceFile));
const refKeys = collectKeys(refMap);

let hasErrors = false;

for (const file of files) {
  if (file === referenceFile) {
    continue;
  }

  const locale = basename(file, ".ts");
  const localeMap = await loadLocale(join(LOCALES_DIR, file));
  if (!localeMap) {
    console.error(`❌ [${locale}] Could not load translation map from ${file}`);
    hasErrors = true;
    continue;
  }

  const localeKeys = collectKeys(localeMap);
  const missing = [...refKeys].filter((k) => !localeKeys.has(k));
  const extra = [...localeKeys].filter((k) => !refKeys.has(k));

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n❌ [${locale}] Missing ${missing.length} key(s) vs ${REFERENCE_LOCALE}:`);
    for (const k of missing.toSorted((a, b) => a.localeCompare(b))) {
      console.error(`   - ${k}`);
    }
    if (showFix) {
      console.log(`\n💡 Stub for ${locale} (add these to your locale file):`);
      for (const k of missing.toSorted((a, b) => a.localeCompare(b))) {
        console.log(`   "${k.split(".").pop()}": "TODO:${locale}",`);
      }
    }
  }

  if (extra.length > 0) {
    hasErrors = true;
    console.error(`\n⚠️  [${locale}] ${extra.length} extra key(s) not in ${REFERENCE_LOCALE}:`);
    for (const k of extra.toSorted((a, b) => a.localeCompare(b))) {
      console.error(`   + ${k}`);
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✅ [${locale}] All ${refKeys.size} keys match.`);
  }
}

if (hasErrors) {
  console.error("\n🔴 i18n key parity check failed. See above for details.");
  process.exit(1);
} else {
  console.log(`\n🟢 All locales have matching keys (${refKeys.size} keys each).`);
}
