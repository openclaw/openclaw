#!/usr/bin/env node
/**
 * Download local CSV datasets from one or more registered sources (see scripts/sources/).
 *
 *   node local-data-fetch.mjs --out ./data --sources football-data-co-uk --preset england
 *   node local-data-fetch.mjs --out ./data --sources football-data-co-uk,http-csv --preset england --urls https://example.com/a.csv
 *   node local-data-fetch.mjs --out ./data --sources all --preset all --season-range 1993-2025
 *
 * Legacy entry: scripts/football-data-fetch.mjs (defaults to football-data-co-uk only).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SOURCE_REGISTRY, listSourceIds, parseSourcesList } from "./sources/registry.mjs";

function parseArgs(argv) {
  const out = {
    outDir: "./var/football-data",
    /** @type {string | null} */
    sourcesCsv: null,
    season: null,
    /** @type {string | null} */
    seasonRange: null,
    /** @type {string[]} */
    seasonsList: [],
    leagues: [],
    urls: [],
    preset: null,
    delayMs: 400,
    dryRun: false,
    userAgent: null,
    /** @type {string | null} core|extended|full — passed to fbref Python fetch */
    fbrefDepth: null,
    /** @type {string | null} HTTP/SOCKS proxy URL for fbref (soccerdata), e.g. http://127.0.0.1:7890 */
    fbrefProxy: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outDir = argv[++i];
    else if (a === "--sources" || a === "--source") out.sourcesCsv = argv[++i];
    else if (a === "--season") out.season = argv[++i];
    else if (a === "--season-range") out.seasonRange = argv[++i];
    else if (a === "--seasons") {
      out.seasonsList = String(argv[++i] ?? "")
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--leagues")
      out.leagues = String(argv[++i] ?? "")
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--urls")
      out.urls = String(argv[++i] ?? "")
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--preset") out.preset = argv[++i];
    else if (a === "--delay-ms") out.delayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--user-agent") out.userAgent = argv[++i];
    else if (a === "--fbref-depth") out.fbrefDepth = String(argv[++i] ?? "").trim() || null;
    else if (a === "--fbref-proxy") out.fbrefProxy = String(argv[++i] ?? "").trim() || null;
    else if (a === "--help" || a === "-h") {
      console.error(`Fetch local CSV files into --out (manifest.json per batch).

  --out DIR           Output directory (default ./var/football-data)
  --sources A,B       Data sources: ${listSourceIds().join(", ")}, or all (auto sources only; default: football-data-co-uk)
  --season CODE       Single season folder code (Football-Data.co.uk style, e.g. 2526)
  --season-range A-B  Inclusive start years of European season (e.g. 1993-2025)
  --seasons A,B,C     Explicit season codes
  --leagues A,B       League stems (Football-Data.co.uk)
  --preset NAME       Presets vary by source (Football-Data: england|…|all)
  --urls U1,U2        Full URLs (http-csv source, or Football-Data url-only mode)
  --delay-ms N        Pause between HTTP requests (default 400)
  --dry-run           Print planned fetches only
  --user-agent STR    Override User-Agent (default per source)
  --fbref-depth MODE  fbref only: core | extended | full (or env FBREF_DEPTH)
  --fbref-proxy URL   fbref only: proxy for soccerdata (e.g. http://127.0.0.1:7890); or env FBREF_PROXY / HTTPS_PROXY / ALL_PROXY

  Multiple --sources: each source writes to OUT/SOURCE_ID/ (same flags where compatible).
  Combining football-data-co-uk + http-csv: use --preset/--leagues for the site and --urls for extra CSVs.
  fbref: requires Python 3 + pip install soccerdata (see requirements-fbref.txt).

Docs: skills/football-local-data/SKILL.md
`);
      process.exit(0);
    }
  }
  return out;
}

/**
 * @param {string} sourceId
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string[]} sourcesList
 */
function effectiveArgsForSource(sourceId, args, sourcesList) {
  if (
    sourceId === "football-data-co-uk" &&
    sourcesList.length > 1 &&
    sourcesList.includes("http-csv")
  ) {
    return { ...args, urls: [] };
  }
  return args;
}

/**
 * @param {string[]} sourcesList
 * @param {ReturnType<typeof parseArgs>} args
 */
function validateSourcesArgs(sourcesList, args) {
  if (sourcesList.length === 1) {
    const id = sourcesList[0];
    if (id === "http-csv") {
      SOURCE_REGISTRY["http-csv"].validateArgs(args, { combined: false });
    } else {
      SOURCE_REGISTRY[id]?.validateArgs?.(args);
    }
    return;
  }
  if (sourcesList.includes("football-data-co-uk")) {
    SOURCE_REGISTRY["football-data-co-uk"].validateArgs({ ...args, urls: [] });
  }
  if (sourcesList.includes("http-csv")) {
    SOURCE_REGISTRY["http-csv"].validateArgs(args, { combined: true });
  }
  if (sourcesList.includes("fbref")) {
    SOURCE_REGISTRY["fbref"].validateArgs(args);
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOne(url, userAgent) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/csv,text/plain,*/*",
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, buf, url: res.url || url };
}

/**
 * @param {object} opts
 * @param {string} opts.outDir
 * @param {string} opts.season
 * @param {string[]} opts.urls
 * @param {number} opts.delayMs
 * @param {string} opts.userAgent
 * @param {boolean} opts.writeFiles
 * @param {string} opts.manifestSource
 * @param {string} opts.notesUrl
 */
async function fetchBatch({
  outDir,
  season,
  urls,
  delayMs,
  userAgent,
  writeFiles,
  manifestSource,
  notesUrl,
}) {
  const manifest = {
    fetchedAt: new Date().toISOString(),
    source: manifestSource,
    notesUrl,
    season,
    files: [],
  };

  if (writeFiles) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const url of urls) {
    const name = path.basename(new URL(url).pathname) || "download.csv";
    const dest = path.join(outDir, name);

    if (!writeFiles) {
      manifest.files.push({ url, dest: name, ok: true, dryRun: true });
      continue;
    }

    const { ok, status, buf } = await fetchOne(url, userAgent);
    if (!ok) {
      manifest.files.push({
        url,
        dest: name,
        ok: false,
        httpStatus: status,
        error: `HTTP ${status}`,
      });
    } else {
      fs.writeFileSync(dest, buf);
      manifest.files.push({
        url,
        dest: name,
        ok: true,
        httpStatus: status,
        bytes: buf.length,
        sha256: sha256(buf),
      });
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  if (writeFiles) {
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  return manifest;
}

/**
 * @param {string} sourceId
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} outRoot
 * @param {string[]} sourcesList
 */
async function runForSource(sourceId, args, outRoot, sourcesList) {
  const mod = SOURCE_REGISTRY[sourceId];
  const eff = effectiveArgsForSource(sourceId, args, sourcesList);

  if (typeof mod.runFetch === "function") {
    mod.validateArgs?.(eff);
    return await mod.runFetch(eff, outRoot, {
      dryRun: args.dryRun,
      delayMs: args.delayMs,
      fbrefDepth: args.fbrefDepth ?? undefined,
      fbrefProxy: args.fbrefProxy ?? undefined,
    });
  }

  const ua = args.userAgent?.trim() || mod.DEFAULT_USER_AGENT;
  const manifestSource = mod.MANIFEST_SOURCE;
  const notesUrl = mod.NOTES_URL;

  if (sourceId === "football-data-co-uk") {
    const hasManualUrls = eff.urls.length > 0;
    const hasPresetOrLeagues = Boolean(eff.preset) || eff.leagues.length > 0;
    if (hasManualUrls && !hasPresetOrLeagues) {
      mod.validateArgs(eff);
      const season = eff.season || mod.seasonCodeFromDate();
      if (args.dryRun) {
        console.log(
          JSON.stringify(
            { sourceId, season, urls: eff.urls, outDir: outRoot, mode: "urls-only" },
            null,
            2,
          ),
        );
        return { sourceId, summaries: [] };
      }
      const manifest = await fetchBatch({
        outDir: outRoot,
        season,
        urls: eff.urls,
        delayMs: args.delayMs,
        userAgent: ua,
        writeFiles: true,
        manifestSource,
        notesUrl,
      });
      console.error(
        `[local-data-fetch] ${sourceId} urls-only → ${outRoot} (${manifest.files.filter((f) => f.ok).length}/${manifest.files.length} ok)`,
      );
      return { sourceId, summaries: [{ manifest }] };
    }
  }

  const seasons = mod.resolveSeasons(eff);
  const multi = seasons.length > 1;

  for (const season of seasons) {
    const urls = mod.buildUrlsForSeason(eff, season);
    if (!urls.length) {
      throw new Error(`Source "${sourceId}": no URLs to fetch (set --preset/--leagues or --urls).`);
    }
  }

  if (args.dryRun) {
    const plan = seasons.map((season) => ({
      season,
      outDir: multi ? path.join(outRoot, season) : outRoot,
      urls: mod.buildUrlsForSeason(eff, season),
    }));
    console.log(JSON.stringify({ sourceId, multi, seasons, plan }, null, 2));
    return { sourceId, summaries: [], dryRun: true };
  }

  const summaries = [];
  for (const season of seasons) {
    const urls = mod.buildUrlsForSeason(eff, season);
    const outDir = multi ? path.join(outRoot, season) : outRoot;
    const manifest = await fetchBatch({
      outDir,
      season,
      urls,
      delayMs: args.delayMs,
      userAgent: ua,
      writeFiles: true,
      manifestSource,
      notesUrl,
    });
    summaries.push({
      season,
      outDir,
      okCount: manifest.files.filter((f) => f.ok).length,
      manifest,
    });
    console.error(
      `[local-data-fetch] ${sourceId} season ${season} → ${outDir} (${manifest.files.filter((f) => f.ok).length}/${manifest.files.length} ok)`,
    );
  }

  if (multi) {
    const index = {
      fetchedAt: new Date().toISOString(),
      source: manifestSource,
      sourceId,
      notesUrl,
      outDir: outRoot,
      seasons,
      batches: summaries.map((s) => ({
        season: s.season,
        dir: s.outDir,
        files: s.manifest.files.length,
        ok: s.okCount,
      })),
    };
    fs.mkdirSync(outRoot, { recursive: true });
    fs.writeFileSync(path.join(outRoot, "index.json"), JSON.stringify(index, null, 2));
  }

  return { sourceId, summaries };
}

async function main() {
  const args = parseArgs(process.argv);
  const sourcesList = parseSourcesList(args.sourcesCsv ?? "football-data-co-uk");

  validateSourcesArgs(sourcesList, args);

  const multiSource = sourcesList.length > 1;
  const baseOut = args.outDir;

  if (args.dryRun) {
    for (const sourceId of sourcesList) {
      const outRoot = multiSource ? path.join(baseOut, sourceId) : baseOut;
      await runForSource(sourceId, args, outRoot, sourcesList);
    }
    return;
  }

  /** @type {object[]} */
  const allOut = [];

  for (const sourceId of sourcesList) {
    const outRoot = multiSource ? path.join(baseOut, sourceId) : baseOut;
    const r = await runForSource(sourceId, args, outRoot, sourcesList);
    allOut.push(r);
  }

  if (multiSource) {
    const index = {
      fetchedAt: new Date().toISOString(),
      outDir: baseOut,
      sources: sourcesList,
      batches: allOut.map((r) => ({ sourceId: r.sourceId })),
    };
    fs.mkdirSync(baseOut, { recursive: true });
    fs.writeFileSync(path.join(baseOut, "index.json"), JSON.stringify(index, null, 2));
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
