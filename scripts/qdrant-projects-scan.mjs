#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "qdrant-setup", "projects.json");

const IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".openclaw",
  ".cache",
  "tmp",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

function parseArgs(argv) {
  const args = { roots: ["/root/clawd"], out: DEFAULT_OUT, enableAll: false, maxDepth: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--roots" && i + 1 < argv.length) {
      args.roots = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (a.startsWith("--roots=")) {
      args.roots = a
        .slice("--roots=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === "--out" && i + 1 < argv.length) {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (a.startsWith("--out=")) {
      args.out = a.slice("--out=".length);
      continue;
    }
    if (a === "--enable-all") {
      args.enableAll = true;
      continue;
    }
    if (a === "--max-depth" && i + 1 < argv.length) {
      args.maxDepth = Number(argv[i + 1]) || args.maxDepth;
      i += 1;
      continue;
    }
    if (a.startsWith("--max-depth=")) {
      args.maxDepth = Number(a.slice("--max-depth=".length)) || args.maxDepth;
      continue;
    }
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: scripts/qdrant-projects-scan.mjs [options]",
      "",
      "Options:",
      "  --roots <csv>       Root directories to scan (default: /root/clawd)",
      "  --out <path>        Output JSON file path (default: qdrant-setup/projects.json)",
      "  --enable-all        Mark generated projects as enabled=true",
      "  --max-depth <n>     Scan depth from each root (default: 3)",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function existsFile(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function existsDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function looksLikeProject(dir) {
  const markers = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "pubspec.yaml",
    "requirements.txt",
    "Dockerfile",
    "README.md",
  ];

  for (const name of markers) {
    const p = path.join(dir, name);
    if (name === ".git") {
      if (await existsDir(p)) return true;
    } else if (await existsFile(p)) {
      return true;
    }
  }
  return false;
}

function toProjectId(absPath) {
  const base = path.basename(absPath);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

async function scanRoot(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();

    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORE_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const abs = path.join(dir, entry.name);
      if (await looksLikeProject(abs)) {
        out.push(abs);
      }

      stack.push({ dir: abs, depth: depth + 1 });
    }
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = args.roots.map((r) => (path.isAbsolute(r) ? r : path.resolve(REPO_ROOT, r)));

  const found = new Set();
  for (const root of roots) {
    if (!(await existsDir(root))) continue;
    const projects = await scanRoot(root, args.maxDepth);
    for (const p of projects) {
      if (p === REPO_ROOT) continue;
      found.add(p);
    }
  }

  const sorted = Array.from(found).sort((a, b) => a.localeCompare(b));
  const idCounts = new Map();
  const projects = sorted.map((abs) => {
    const rawId = toProjectId(abs);
    const n = (idCounts.get(rawId) || 0) + 1;
    idCounts.set(rawId, n);
    const id = n === 1 ? rawId : `${rawId}-${n}`;
    return { id, path: abs, enabled: !!args.enableAll };
  });

  const outPath = path.isAbsolute(args.out) ? args.out : path.resolve(REPO_ROOT, args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify({ projects }, null, 2)}\n`, "utf8");

  process.stdout.write(`Wrote ${projects.length} projects to ${outPath}\n`);
  process.stdout.write("Tip: review and enable only relevant projects for indexing.\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
