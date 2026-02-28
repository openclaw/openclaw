#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "../lib/paths.js";

function parseArgs(argv) {
  const args = { roots: [], incremental: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a value");
      args.roots.push(value);
      i += 1;
    } else if (arg === "--index") {
      args.index = argv[i + 1];
      i += 1;
    } else if (arg === "--incremental") {
      args.incremental = true;
    } else if (arg === "--max-depth") {
      args.maxDepth = Number(argv[i + 1] || 8);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function walkPsd(root, maxDepth = 8) {
  const files = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".psd")) {
        files.push(full);
      }
    }
  }
  walk(root, 0);
  return files;
}

function readSidecarMeta(psdPath) {
  const sidecar = `${psdPath}.openclaw.json`;
  if (!fs.existsSync(sidecar)) return {};
  try {
    return JSON.parse(fs.readFileSync(sidecar, "utf8"));
  } catch {
    return {};
  }
}

function buildEntry(psdPath, rootPath, previousByPath) {
  const stat = fs.statSync(psdPath);
  const previous = previousByPath.get(psdPath);
  if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
    return previous;
  }
  const meta = readSidecarMeta(psdPath);
  return {
    path: psdPath,
    root: rootPath,
    project: path.basename(rootPath),
    modified: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    layers: Array.isArray(meta.layers) ? meta.layers : [],
    textContents: Array.isArray(meta.textContents) ? meta.textContents : [],
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      "Usage: build-index.js [--root <dir>]... [--index <path>] [--incremental] [--max-depth <n>]\n",
    );
    return;
  }

  const indexPath = path.resolve(expandHome(args.index || "~/.openclaw/psd-index.json"));
  const roots =
    args.roots.length > 0
      ? args.roots.map((r) => path.resolve(expandHome(r)))
      : [path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Documents")];

  let previousByPath = new Map();
  if (args.incremental && fs.existsSync(indexPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      previousByPath = new Map((existing.files || []).map((f) => [f.path, f]));
    } catch {
      previousByPath = new Map();
    }
  }

  const allEntries = [];
  for (const root of roots) {
    const psdFiles = walkPsd(root, args.maxDepth || 8);
    for (const psdPath of psdFiles) {
      try {
        allEntries.push(buildEntry(psdPath, root, previousByPath));
      } catch {
        // Skip unreadable files and continue index build.
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    roots,
    files: allEntries,
  };
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        indexPath,
        roots: roots.length,
        files: allEntries.length,
      },
      null,
      2,
    ) + "\n",
  );
}

main();
