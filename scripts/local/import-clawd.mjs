import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    source: null,
    out: null,
    includeMemory: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === "--source") args.source = argv[++i] ?? null;
    else if (cur === "--out") args.out = argv[++i] ?? null;
    else if (cur === "--no-memory") args.includeMemory = false;
    else if (cur === "--help" || cur === "-h") args.help = true;
    else if (cur?.startsWith("--")) throw new Error(`Unknown flag: ${cur}`);
  }
  return args;
}

function expandUserPath(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyFileIfExists(from, to) {
  if (!(await pathExists(from))) return false;
  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
  return true;
}

async function copyDir(fromDir, toDir) {
  await ensureDir(toDir);
  const entries = await fs.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(fromDir, entry.name);
    const dst = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dst);
    } else if (entry.isFile()) {
      await ensureDir(path.dirname(dst));
      await fs.copyFile(src, dst);
    }
  }
}

function formatList(items) {
  return items.length ? items.map((v) => `- ${v}`).join("\n") : "- (none)";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        "Usage: node scripts/local/import-clawd.mjs [flags]",
        "",
        "Flags:",
        "  --source <dir>   Source folder (default: ~/clawd)",
        "  --out <dir>      Output folder (default: ./.local/clawd)",
        "  --no-memory      Do not copy memory/ (can be large)",
        "",
      ].join("\n"),
    );
    return;
  }

  const source = expandUserPath(args.source ?? "~/clawd");
  const outDir = expandUserPath(args.out ?? path.join(process.cwd(), ".local", "clawd"));

  if (!(await pathExists(source))) {
    throw new Error(`Source folder not found: ${source}`);
  }

  const copied = [];
  const missing = [];
  const topFiles = [
    "AGENTS.md",
    "HEARTBEAT.md",
    "SOUL.md",
    "TOOLS.md",
    "USER.md",
    "IDENTITY.md",
    "MEMORY.md",
  ];
  for (const name of topFiles) {
    const ok = await copyFileIfExists(path.join(source, name), path.join(outDir, name));
    (ok ? copied : missing).push(name);
  }

  if (args.includeMemory) {
    const mem = path.join(source, "memory");
    if (await pathExists(mem)) {
      await copyDir(mem, path.join(outDir, "memory"));
      copied.push("memory/**");
    } else {
      missing.push("memory/**");
    }
  }

  process.stdout.write(
    [
      "Import complete.",
      "",
      `Source: ${source}`,
      `Out:    ${outDir}`,
      "",
      "Copied:",
      formatList(copied),
      "",
      "Missing:",
      formatList(missing),
      "",
      "Notes:",
      "- Out dir is under .local/ and is gitignored by default.",
      "",
    ].join("\n"),
  );
}

await main();

