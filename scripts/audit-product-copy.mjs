#!/usr/bin/env node
/**
 * Audit user-visible copy for bare OpenClaw branding in ClaWorks product surfaces.
 *
 * Usage:
 *   node scripts/audit-product-copy.mjs [--strict] [--json]
 *
 * Scans: src/cli, src/commands, src/flows, extension doctor-contract files.
 *
 * Exemptions: schema.help.ts source, CHANGELOG, internal tui/progress, test files.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const jsonOut = args.has("--json");

const EXEMPT_PATH_PARTS = [
  "schema.help.ts",
  "CHANGELOG.md",
  ".test.ts",
  ".test.tsx",
  "update-cli/progress",
  "tui/",
  "node_modules/",
  "dist/",
];

const PATTERNS = [
  {
    id: "openclaw-cmd",
    re: /(?<!formatCliCommand\(["'`])["'`]openclaw (?:doctor|configure|gateway|onboard)/,
  },
  { id: "openclaw-path", re: /~\/\.openclaw(?:\/|["'`\s]|$)/ },
  { id: "openclaw-port", re: /\b18789\b/ },
  { id: "bare-openclaw-configure", re: /run "openclaw configure"/ },
  { id: "bare-openclaw-doctor-fix", re: /Run "openclaw doctor --fix"/ },
];

const SCAN_ROOTS = ["src/cli", "src/commands", "src/flows"];

function isExempt(relPath) {
  return EXEMPT_PATH_PARTS.some((part) => relPath.includes(part));
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    if (isExempt(rel)) continue;
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function collectExtensionDoctorFiles() {
  const extRoot = path.join(repoRoot, "extensions");
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(extRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extRoot, entry.name);
    for (const name of ["doctor-contract.ts", "doctor-contract-api.ts", "index.ts"]) {
      const candidate = path.join(extDir, "src", name);
      const candidateFlat = path.join(extDir, name);
      for (const file of [candidate, candidateFlat]) {
        try {
          await fs.access(file);
          out.push(file);
        } catch {
          // skip
        }
      }
    }
  }
  return out;
}

async function scanFile(filePath) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (isExempt(rel)) return [];
  const text = await fs.readFile(filePath, "utf8");
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("formatCliCommand(") || line.includes("productizeUserCopy(")) continue;
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        hits.push({ file: rel, line: i + 1, pattern: pattern.id, text: line.trim() });
      }
    }
  }
  return hits;
}

async function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    await walk(path.join(repoRoot, root), files);
  }
  for (const f of await collectExtensionDoctorFiles()) {
    files.push(f);
  }

  const allHits = [];
  for (const file of files) {
    allHits.push(...(await scanFile(file)));
  }

  const report = {
    scannedFiles: files.length,
    hits: allHits,
    strict,
  };

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[audit-product-copy] scanned ${files.length} files, ${allHits.length} hit(s)`);
    for (const hit of allHits) {
      console.log(`  ${hit.file}:${hit.line} [${hit.pattern}] ${hit.text.slice(0, 120)}`);
    }
  }

  if (strict && allHits.length > 0) {
    process.exitCode = 1;
  }
}

await main();
