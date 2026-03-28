#!/usr/bin/env node
/**
 * Kaggle dataset downloads for football CSV workflows (official Kaggle API CLI).
 *
 * Auth (pick one):
 *   - Env: KAGGLE_USERNAME + KAGGLE_KEY (fits skills.entries.football_match_analyst.env)
 *   - File: ~/.kaggle/kaggle.json (from kaggle.com → Account → API)
 *
 * Single dataset:
 *   node scripts/kaggle-fetch.mjs --dataset hugomathien/soccer --out ./var/kaggle-soccer
 * Batch (datasets you own on Kaggle):
 *   node scripts/kaggle-fetch.mjs --mine --out ./var/kaggle-mine
 *   node scripts/kaggle-fetch.mjs --mine --dry-run
 *   node scripts/kaggle-fetch.mjs --mine --max 3 --out ./var/kaggle-mine
 *
 * Then use match-context with --provider football-data --csv <path/to.csv> (see SKILL.md).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    outDir: null,
    dataset: null,
    mine: false,
    dryRun: false,
    max: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outDir = argv[++i];
    else if (a === "--dataset") out.dataset = String(argv[++i] ?? "").trim() || null;
    else if (a === "--mine") out.mine = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max") out.max = Math.max(1, Number(argv[++i]) || 0);
    else if (a === "--help" || a === "-h") {
      console.error(`Kaggle dataset fetch (pip install -r requirements-kaggle.txt).

Auth: KAGGLE_USERNAME + KAGGLE_KEY in env, or ~/.kaggle/kaggle.json

  --dataset OWNER/SLUG   Download one dataset into --out
  --mine                 Download every dataset your account owns (kaggle datasets list -m)
  --out DIR              Output directory (required unless --dry-run with --dataset)
  --dry-run              With --mine: list refs only; with --dataset: print planned fetch JSON
  --max N                With --mine: cap downloads

Examples:
  node scripts/kaggle-fetch.mjs --dataset hugomathien/soccer --out ./var/kaggle-soccer
  node scripts/kaggle-fetch.mjs --mine --out ./var/kaggle-mine
`);
      process.exit(0);
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @param {string} base
 */
function summarizeTree(dir, base = dir) {
  /** @type {string[]} */
  const relPaths = [];
  let totalFiles = 0;
  let totalBytes = 0;

  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else {
        totalFiles += 1;
        try {
          totalBytes += fs.statSync(p).size;
        } catch {
          // ignore
        }
        if (relPaths.length < 200) {
          relPaths.push(path.relative(base, p));
        }
      }
    }
  }
  walk(dir);
  return { relPaths, totalFiles, totalBytes };
}

/**
 * @param {string[]} dlArgs
 */
function runSpawn(cmd, argv) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, argv, { stdio: "inherit", env: { ...process.env } });
    proc.on("error", (err) => resolve({ code: -1, err }));
    proc.on("close", (c) => resolve({ code: c ?? 1, err: null }));
  });
}

async function kaggleDownload(slug, destDir) {
  const dlArgs = ["datasets", "download", "-d", slug, "-p", destDir, "--unzip", "--force"];
  let last = await runSpawn("kaggle", dlArgs);
  if (last.code !== 0) {
    last = await runSpawn("python3", ["-m", "kaggle", ...dlArgs]);
  }
  return last;
}

function listMineRefs() {
  const py = path.join(__dirname, "kaggle-list-mine-refs.py");
  const r = spawnSync("python3", [py], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `kaggle-list-mine-refs.py exited ${r.status}`);
  }
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runSingleDataset(slug, outRoot, dryRun) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(slug)) {
    throw new Error(`Invalid --dataset "${slug}"; expected owner/slug`);
  }
  const [owner, datasetName] = slug.split("/");

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dataset",
          kaggleDataset: slug,
          outDir: outRoot,
          dryRun: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!outRoot) {
    throw new Error("--out is required for --dataset");
  }

  fs.mkdirSync(outRoot, { recursive: true });

  const last = await kaggleDownload(slug, outRoot);
  if (last.code !== 0) {
    const hint =
      "Set KAGGLE_USERNAME + KAGGLE_KEY or ~/.kaggle/kaggle.json. pip install kaggle. https://www.kaggle.com/docs/api";
    const extra = last.err ? `${String(last.err.message)}. ` : "";
    throw new Error(`kaggle CLI failed (exit ${last.code}). ${extra}${hint}`);
  }

  const { relPaths, totalFiles, totalBytes } = summarizeTree(outRoot);
  const manifest = {
    fetchedAt: new Date().toISOString(),
    source: "kaggle-datasets",
    notesUrl: `https://www.kaggle.com/datasets/${owner}/${datasetName}`,
    kaggleDataset: slug,
    authNote: "credentials from KAGGLE_USERNAME/KAGGLE_KEY or ~/.kaggle/kaggle.json (not logged)",
    outDir: path.resolve(outRoot),
    totalFiles,
    totalBytes,
    filesSample: relPaths,
    filesSampleTruncated: totalFiles > relPaths.length,
  };
  fs.writeFileSync(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  console.error(`[kaggle-fetch] ${slug} → ${outRoot} (${totalFiles} files)`);
}

async function runMine(outDir, dryRun, max) {
  const refs = listMineRefs();
  const limited = max != null ? refs.slice(0, max) : refs;

  console.error(`[kaggle-fetch] --mine: ${refs.length} dataset(s); processing ${limited.length}`);

  if (dryRun) {
    for (const ref of limited) {
      console.log(ref);
    }
    return;
  }

  if (!outDir) {
    throw new Error("--out is required for --mine (unless --dry-run)");
  }

  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });

  const batch = {
    fetchedAt: new Date().toISOString(),
    source: "kaggle-fetch-mine",
    notesUrl: "https://www.kaggle.com/docs/api",
    outDir: root,
    datasets: [],
  };

  for (const ref of limited) {
    const parts = ref.split("/");
    const owner = parts[0];
    const slugPart = parts[1];
    const destDir = path.join(root, owner, slugPart);
    fs.mkdirSync(destDir, { recursive: true });
    console.error(`[kaggle-fetch] downloading ${ref} → ${destDir}`);
    const last = await kaggleDownload(ref, destDir);
    batch.datasets.push({
      ref,
      destDir,
      ok: last.code === 0,
      exitCode: last.code,
    });
  }

  fs.writeFileSync(path.join(root, "batch-manifest.json"), JSON.stringify(batch, null, 2), "utf-8");
  const ok = batch.datasets.filter((d) => d.ok).length;
  console.error(
    `[kaggle-fetch] done ${ok}/${batch.datasets.length} ok → ${path.join(root, "batch-manifest.json")}`,
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.mine && args.dataset) {
    throw new Error("Use either --mine or --dataset, not both");
  }

  if (args.mine) {
    await runMine(args.outDir, args.dryRun, args.max);
    return;
  }

  if (args.dataset) {
    await runSingleDataset(args.dataset, args.outDir, args.dryRun);
    return;
  }

  throw new Error("Specify --dataset OWNER/SLUG or --mine (see --help)");
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
