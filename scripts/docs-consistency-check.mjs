#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_JSON_PATH = path.join(ROOT, "docs", "docs.json");
const CHANNELS_DIR = path.join(ROOT, "docs", "channels");
const LABELER_PATH = path.join(ROOT, ".github", "labeler.yml");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

if (!fs.existsSync(DOCS_JSON_PATH)) {
  console.error("docs:check-consistency: missing docs/docs.json.");
  process.exit(1);
}
if (!fs.existsSync(CHANNELS_DIR)) {
  console.error("docs:check-consistency: missing docs/channels directory.");
  process.exit(1);
}
if (!fs.existsSync(LABELER_PATH)) {
  console.error("docs:check-consistency: missing .github/labeler.yml.");
  process.exit(1);
}
if (!fs.existsSync(EXTENSIONS_DIR)) {
  console.error("docs:check-consistency: missing extensions directory.");
  process.exit(1);
}

const docsConfig = JSON.parse(fs.readFileSync(DOCS_JSON_PATH, "utf8"));
const labelerContents = fs.readFileSync(LABELER_PATH, "utf8");

const navPages = new Set(collectPageEntries(docsConfig.navigation ?? []));

const channelDocSlugs = fs
  .readdirSync(CHANNELS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name.replace(/\.md$/, ""))
  .filter((slug) => slug !== "index")
  .map((slug) => `channels/${slug}`)
  .toSorted();

const missingChannelPages = channelDocSlugs.filter((slug) => !navPages.has(slug));

const extensionDirs = fs
  .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted();

// Only enforce mapping for real plugin extensions.
const pluginExtensions = extensionDirs.filter((name) =>
  fs.existsSync(path.join(EXTENSIONS_DIR, name, "openclaw.plugin.json")),
);

const missingExtensionLabelerMappings = pluginExtensions.filter((name) => {
  const escaped = escapeRegExp(`extensions/${name}/**`);
  return !new RegExp(`["']${escaped}["']`).test(labelerContents);
});

const totalChecks = channelDocSlugs.length + pluginExtensions.length;
const totalFailures = missingChannelPages.length + missingExtensionLabelerMappings.length;

console.log(`consistency_checks=${totalChecks}`);
console.log(`consistency_failures=${totalFailures}`);

if (missingChannelPages.length > 0) {
  console.log("missing_docs_navigation_pages:");
  for (const page of missingChannelPages) {
    console.log(`  - ${page}`);
  }
}

if (missingExtensionLabelerMappings.length > 0) {
  console.log("missing_labeler_extension_mappings:");
  for (const name of missingExtensionLabelerMappings) {
    console.log(`  - extensions/${name}/**`);
  }
}

if (totalFailures > 0) {
  process.exit(1);
}

/**
 * Recursively collect page entries from Mintlify docs navigation.
 * @param {unknown} node
 * @returns {string[]}
 */
function collectPageEntries(node) {
  /** @type {string[]} */
  const out = [];

  if (Array.isArray(node)) {
    for (const item of node) {
      out.push(...collectPageEntries(item));
    }
    return out;
  }

  if (!node || typeof node !== "object") {
    return out;
  }

  const obj = /** @type {Record<string, unknown>} */ (node);
  if (Array.isArray(obj.pages)) {
    for (const value of obj.pages) {
      if (typeof value === "string") {
        out.push(value);
      }
    }
  }

  for (const value of Object.values(obj)) {
    out.push(...collectPageEntries(value));
  }
  return out;
}

/**
 * @param {string} input
 * @returns {string}
 */
function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
