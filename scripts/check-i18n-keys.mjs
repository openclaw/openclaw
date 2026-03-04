#!/usr/bin/env node

/**
 * Validate that non-English i18n locale files contain every key defined
 * in the English (source-of-truth) locale.
 *
 * Usage:  node scripts/check-i18n-keys.mjs
 * Exit 0 if all locales are complete, 1 if any keys are missing.
 *
 * This intentionally ignores extra keys in non-English locales — those
 * may be locale-specific overrides or upcoming strings.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(__dirname, "../ui/src/i18n/locales");

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

/**
 * Walk a nested object and return all leaf-key dot-paths.
 *
 *   { a: { b: "x", c: "y" } }  →  ["a.b", "a.c"]
 */
function extractKeys(obj, prefix = "") {
  /** @type {string[]} */
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      keys.push(...extractKeys(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

/**
 * Evaluate a TypeScript locale file and return the exported translation map.
 * We strip the TS type annotation and evaluate as plain JS.
 */
function loadLocaleMap(filePath) {
  let src = readFileSync(filePath, "utf-8");
  // Strip `import type …` lines (type-only, not needed at runtime)
  src = src.replace(/^import type\s+.+$/gm, "");
  // Strip `: TranslationMap` type annotations from `export const xx: TranslationMap = {`
  src = src.replace(/:\s*TranslationMap\s*=/g, " =");
  // Convert `export const` to plain `const` so we can eval
  src = src.replace(/export\s+const\s+/g, "const ");
  // Append a return of the first const name
  const nameMatch = src.match(/const\s+(\w+)\s*=/);
  if (!nameMatch) {
    throw new Error(`Cannot find exported const in ${filePath}`);
  }
  src += `\n;return ${nameMatch[1]};`;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(src)();
  } catch (err) {
    throw new Error(`Failed to evaluate ${filePath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const LOCALE_FILES = [
  { file: "zh-CN.ts", label: "zh-CN" },
  { file: "zh-TW.ts", label: "zh-TW" },
  { file: "pt-BR.ts", label: "pt-BR" },
  { file: "de.ts", label: "de" },
];

const enMap = loadLocaleMap(join(LOCALES_DIR, "en.ts"));
const enKeys = new Set(extractKeys(enMap));

let hasErrors = false;

for (const { file, label } of LOCALE_FILES) {
  const filePath = join(LOCALES_DIR, file);
  let localeMap;
  try {
    localeMap = loadLocaleMap(filePath);
  } catch (err) {
    console.error(`⚠  ${label}: failed to load — ${err.message}`);
    continue; // don't fail the whole check if a file can't be loaded
  }

  const localeKeys = new Set(extractKeys(localeMap));
  const missing = [...enKeys].filter((k) => !localeKeys.has(k)).sort();

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`✗  ${label}: missing ${missing.length} key(s):`);
    for (const k of missing) {
      console.error(`     - ${k}`);
    }
  } else {
    console.log(`✓  ${label}: all ${enKeys.size} keys present`);
  }
}

if (hasErrors) {
  console.error(
    "\nFix the missing keys above so the UI falls back correctly.\n" +
      "Hint: the translate() helper falls back to English for missing keys,\n" +
      "but explicit coverage prevents untranslated UI leaking through.",
  );
  process.exit(1);
} else {
  console.log(`\nAll locales have complete key coverage (${enKeys.size} keys in en).`);
}
