#!/usr/bin/env node

/**
 * scripts/rebrand.mjs — Rebrand SmartAgentNeo -> Smart Agent Neo
 *
 * Usage:  node scripts/rebrand.mjs [--dry-run]
 *
 * Phase A: Content replacement in text files
 * Phase B: File renames via git mv
 * Phase C: Directory renames via git mv (deepest-first)
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, basename, dirname, extname, relative } from "node:path";
import { execSync } from "node:child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = process.cwd();

// ── Skip / Binary Configuration ──────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".bmp",
  ".tiff", ".tif",
  ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".aac", ".flac",
  ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".node",
  ".class", ".jar", ".pyc", ".pyo", ".o", ".a", ".obj",
  ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".ds_store",
]);

// ── Content Replacement Rules ────────────────────────────────────────
// ORDER MATTERS: most specific / longest patterns first to prevent
// double-replacement. Each rule is [RegExp, replacement string].

const RULES = [
  // GitHub org/repo URLs (before general smart-agent-neo)
  [/github\.com\/smart-agent-neo\/smart-agent-neo/g, "github.com/betterbrand/smart-agent-neo"],

  // Env vars: specific compound before prefix
  [/SMARTAGENTNEOKIT_BUNDLE/g, "SMARTAGENTNEOKIT_BUNDLE"],
  [/SMART_AGENT_NEO_/g, "SMART_AGENT_NEO_"],

  // Bundle IDs / Java packages
  [/ai\.smart-agent-neo\./g, "ai.smartagentneo."],

  // Ecosystem: neo-contributors
  [/Neo-Contributors/g, "Neo-Contributors"],
  [/neo-contributors/g, "neo-contributors"],

  // Ecosystem: NeoStrike
  [/NeoStrike/g, "NeoStrike"],
  [/neostrike/g, "neostrike"],

  // Ecosystem: NeoDock / neodock
  [/NeoDock/g, "NeoDock"],
  [/Neodock/g, "Neodock"],
  [/neodock/g, "neodock"],
  [/NEODOCK/g, "NEODOCK"],

  // Ecosystem: NeoBot
  [/NeoBot/g, "NeoBot"],
  [/Neobot/g, "Neobot"],
  [/neobot/g, "neobot"],
  [/NEOBOT/g, "NEOBOT"],

  // Ecosystem: Neospace
  [/Neospace/g, "Neospace"],
  [/neospace/g, "neospace"],

  // Ecosystem: NeoHub
  [/NeoHub/g, "NeoHub"],
  [/Neohub/g, "Neohub"],
  [/neohub/g, "neohub"],
  [/NEOHUB/g, "NEOHUB"],

  // Ecosystem: NeoNet
  [/NeoNet/g, "NeoNet"],
  [/Neonet/g, "Neonet"],
  [/neonet/g, "neonet"],

  // Ecosystem: neolog
  [/neolog/g, "neolog"],

  // Legacy: NeoBot
  [/NeoBot/g, "NeoBot"],
  [/neobot/g, "neobot"],

  // Main brand: PascalCase (handles SmartAgentNeoKit, SmartAgentNeoProtocol, etc.)
  [/SmartAgentNeo/g, "SmartAgentNeo"],

  // Main brand: SCREAMING_CASE (remaining after SMART_AGENT_NEO_ prefix rule)
  [/SMART_AGENT_NEO/g, "SMART_AGENT_NEO"],

  // Main brand: camelCase with explicit capital C
  [/smartAgentNeo/g, "smartAgentNeo"],

  // Main brand: smart-agent-neo followed by uppercase (camelCase continuation)
  // e.g. smartAgentNeoRoot -> smartAgentNeoRoot
  [/smart-agent-neo(?=[A-Z])/g, "smartAgentNeo"],

  // Main brand: lowercase/kebab (remaining standalone uses)
  // e.g. smart-agent-neo.mjs -> smart-agent-neo.mjs
  [/smart-agent-neo/g, "smart-agent-neo"],

  // Remaining Neo pun -> Neo (handles NeoAuth, Neoia, etc.)
  [/Neo/g, "Neo"],
  [/neo/g, "neo"],
  [/NEO/g, "NEO"],

  // Remaining Neo -> Neo (catch-all for Neontroversy, neobot, etc.)
  [/Neo/g, "Neo"],
  [/neo/g, "neo"],
  [/NEO/g, "NEO"],
];

// ── File / Directory Renaming Rules ──────────────────────────────────

function renameComponent(name) {
  let r = name;
  // Ecosystem (longest/most-specific first)
  r = r.replace(/neo-contributors/g, "neo-contributors");
  r = r.replace(/Neo-Contributors/g, "Neo-Contributors");
  r = r.replace(/NeoStrike/g, "NeoStrike");
  r = r.replace(/neostrike/g, "neostrike");
  r = r.replace(/NeoDock/g, "NeoDock");
  r = r.replace(/Neodock/g, "Neodock");
  r = r.replace(/neodock/g, "neodock");
  r = r.replace(/NeoBot/g, "NeoBot");
  r = r.replace(/neobot/g, "neobot");
  r = r.replace(/Neospace/g, "Neospace");
  r = r.replace(/neospace/g, "neospace");
  r = r.replace(/NeoHub/g, "NeoHub");
  r = r.replace(/neohub/g, "neohub");
  r = r.replace(/NeoNet/g, "NeoNet");
  r = r.replace(/neonet/g, "neonet");
  r = r.replace(/neolog/g, "neolog");
  r = r.replace(/NeoBot/g, "NeoBot");
  r = r.replace(/neobot/g, "neobot");
  // Main brand
  r = r.replace(/SmartAgentNeo/g, "SmartAgentNeo");
  r = r.replace(/SMART_AGENT_NEO/g, "SMART_AGENT_NEO");
  r = r.replace(/smart-agent-neo/g, "smart-agent-neo");
  // Remaining
  r = r.replace(/Neo/g, "Neo");
  r = r.replace(/neo/g, "neo");
  r = r.replace(/NEO/g, "NEO");
  r = r.replace(/Neo/g, "Neo");
  r = r.replace(/neo/g, "neo");
  r = r.replace(/NEO/g, "NEO");
  return r;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function walkFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        results.push(...(await walkFiles(full)));
      }
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (BINARY_EXTS.has(extname(entry.name).toLowerCase())) continue;
      results.push(full);
    }
  }
  return results;
}

function hasBinaryContent(buf) {
  const check = Math.min(buf.length, 8192);
  for (let i = 0; i < check; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function applyRules(text) {
  let result = text;
  for (const [pattern, replacement] of RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function gitMv(from, to) {
  execSync(`git mv ${JSON.stringify(from)} ${JSON.stringify(to)}`, {
    cwd: ROOT,
    stdio: "pipe",
  });
}

// ── Phase A: Content Replacement ─────────────────────────────────────

async function phaseA() {
  console.log("\n--- Phase A: Content Replacement ---\n");
  const files = await walkFiles(ROOT);
  let changed = 0;
  let scanned = 0;

  for (const file of files) {
    scanned++;
    try {
      const buf = await readFile(file);
      if (hasBinaryContent(buf)) continue;

      const text = buf.toString("utf-8");
      const updated = applyRules(text);

      if (updated !== text) {
        changed++;
        const rel = relative(ROOT, file);
        if (!DRY_RUN) {
          await writeFile(file, updated, "utf-8");
        }
        if (changed <= 20 || changed % 200 === 0) {
          console.log(`  ${DRY_RUN ? "[dry]" : "OK"} ${rel}`);
        }
      }
    } catch (err) {
      console.error(`  ERR ${relative(ROOT, file)}: ${err.message}`);
    }
  }

  console.log(
    `\n  Phase A complete: ${changed} files updated (${scanned} scanned)`,
  );
}

// ── Phase B: File Renames ────────────────────────────────────────────

async function phaseB() {
  console.log("\n--- Phase B: File Renames ---\n");

  const output = execSync("git ls-files", { cwd: ROOT, encoding: "utf-8" });
  const files = output.trim().split("\n");
  const renames = [];

  for (const file of files) {
    const base = basename(file);
    if (!/neo|molt/i.test(base)) continue;

    const newBase = renameComponent(base);
    if (newBase !== base) {
      renames.push([file, join(dirname(file), newBase)]);
    }
  }

  console.log(`  ${renames.length} files to rename\n`);

  for (const [from, to] of renames) {
    if (DRY_RUN) {
      console.log(`  [dry] ${from} -> ${basename(to)}`);
    } else {
      try {
        gitMv(from, to);
      } catch (err) {
        console.error(`  ERR ${from}: ${err.message}`);
      }
    }
  }

  console.log(`\n  Phase B complete: ${renames.length} files renamed`);
}

// ── Phase C: Directory Renames ───────────────────────────────────────

async function phaseC() {
  console.log("\n--- Phase C: Directory Renames ---\n");

  // Re-read file list after Phase B
  const output = execSync("git ls-files", { cwd: ROOT, encoding: "utf-8" });
  const files = output.trim().split("\n");

  // Collect directory paths where a component name contains 'neo'
  const dirSet = new Set();
  for (const file of files) {
    const parts = file.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? current + "/" + parts[i] : parts[i];
      if (/neo/i.test(parts[i])) {
        dirSet.add(current);
      }
    }
  }

  // Sort deepest first so children are renamed before parents
  const sorted = [...dirSet].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );

  const renames = [];
  for (const dir of sorted) {
    const dirName = basename(dir);
    const parent = dirname(dir);

    // Special case: Android/Java package dirs (no hyphens allowed)
    let newDirName;
    if (dir.includes("/java/ai/") && dirName === "smart-agent-neo") {
      newDirName = "smartagentneo";
    } else {
      newDirName = renameComponent(dirName);
    }

    if (newDirName !== dirName) {
      renames.push([dir, join(parent, newDirName)]);
    }
  }

  console.log(`  ${renames.length} directories to rename\n`);

  for (const [from, to] of renames) {
    if (DRY_RUN) {
      console.log(`  [dry] ${from}/ -> ${basename(to)}/`);
    } else {
      try {
        gitMv(from, to);
      } catch (err) {
        console.error(`  ERR ${from}/: ${err.message}`);
      }
    }
  }

  console.log(`\n  Phase C complete: ${renames.length} directories renamed`);
}

// ── Main ─────────────────────────────────────────────────────────────

console.log(`\n  Rebrand: SmartAgentNeo -> Smart Agent Neo`);
console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

const t0 = Date.now();
await phaseA();
await phaseB();
await phaseC();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nDone in ${elapsed}s.`);
console.log('Verify: git grep -i "neo" -- ":!pnpm-lock.yaml"');
console.log('Verify: git ls-files | grep -i neo\n');
