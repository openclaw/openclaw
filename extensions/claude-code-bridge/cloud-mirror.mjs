#!/usr/bin/env node
// Cloud mirror daemon: pushes local OpenClaw wiki deltas to benchagi.com.
//
// Direction is one-way (local vault -> cloud). The local filesystem at
// ~/.openclaw/wiki/{instanceId || 'main'}/ stays authoritative. This daemon
// watches for changes, computes per-file content hashes, and POSTs deltas
// to the /api/v1/wiki/ingest endpoint in the Bench web app.
//
// The cloud mirror is a READ-ONLY copy from the daemon's perspective —
// all approval, rarity-tagging, and harness-manifest publication happen
// via super-admin UI on benchagi.com. The daemon never reads remote state
// back into the local vault.
//
// Env vars:
//   BENCH_WIKI_INGEST_URL    - Override the ingest endpoint (default: https://benchagi.com/api/v1/wiki/ingest)
//   BENCH_WIKI_INGEST_KEY    - Required API key (super-admin scope) for X-API-Key auth
//   BENCH_WIKI_MIRROR_DEBOUNCE_MS  - Debounce window (default: 2000)
//   BENCH_WIKI_MIRROR_BATCH_SIZE   - Entries per POST (default: 50)
//   BENCH_INSTANCE_ID        - Override the instanceId from openclaw.json (advanced)
//
// Config: ~/.openclaw/openclaw.json — top-level `instanceId` selects the
//   per-instance vault directory (~/.openclaw/wiki/{instanceId}/) and is
//   stamped onto each ingest payload as `sourceInstanceId`. When unset, the
//   daemon falls back to single-user Tier A (~/.openclaw/wiki/main/).
//
// State file: ~/.openclaw/state/wiki-mirror.json — tracks per-slug localHash
//   so we only POST when content actually changed.
//
// Log file: ~/.openclaw/logs/wiki-mirror.log — captured by existing
//   ai.openclaw.log-rotator service (03:00 daily rotation).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const OPENCLAW_CONFIG_PATH = path.join(HOME, ".openclaw", "openclaw.json");

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Read `instanceId` from ~/.openclaw/openclaw.json. Returns null when the
 * file is missing, unparseable, or the field is absent/invalid — callers
 * fall back to the single-user Tier A default.
 */
function readInstanceIdFromConfig() {
  const override = process.env.BENCH_INSTANCE_ID;
  if (typeof override === "string" && INSTANCE_ID_PATTERN.test(override)) {
    return override;
  }
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.instanceId;
    if (typeof value === "string" && INSTANCE_ID_PATTERN.test(value)) {
      return value;
    }
  } catch {
    // Missing or unparseable config — Tier A fallback.
  }
  return null;
}

const INSTANCE_ID = readInstanceIdFromConfig();
const VAULT_NAME = INSTANCE_ID ?? "main";
const VAULT_DIR = path.join(HOME, ".openclaw", "wiki", VAULT_NAME);
const STATE_DIR = path.join(HOME, ".openclaw", "state");
// State is keyed per-vault so switching instanceId doesn't re-POST the whole
// previous vault; an unset-then-set transition looks like a fresh sync, which
// is the correct behavior for the cloud-side `sourceInstanceId` tagging.
const STATE_PATH = path.join(
  STATE_DIR,
  INSTANCE_ID ? `wiki-mirror.${INSTANCE_ID}.json` : "wiki-mirror.json",
);
const LOG_DIR = path.join(HOME, ".openclaw", "logs");
const LOG_PATH = path.join(LOG_DIR, "wiki-mirror.log");

const INGEST_URL = process.env.BENCH_WIKI_INGEST_URL ?? "https://benchagi.com/api/v1/wiki/ingest";
const INGEST_KEY = process.env.BENCH_WIKI_INGEST_KEY ?? "";
const DEBOUNCE_MS = Number(process.env.BENCH_WIKI_MIRROR_DEBOUNCE_MS ?? "2000");
const BATCH_SIZE = Number(process.env.BENCH_WIKI_MIRROR_BATCH_SIZE ?? "50");
const MAX_MARKDOWN_BYTES = 512 * 1024;

// ─── Logging ─────────────────────────────────────────────────────────

async function log(level, message, extra = undefined) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(extra ? { extra } : {}),
  });
  await fs.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  await fs.appendFile(LOG_PATH, line + "\n").catch(() => {});
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

// ─── Frontmatter parsing (lightweight, no external dep) ──────────────

function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) {
    return { frontmatter: {}, body: source };
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: source };
  }
  const raw = source.slice(4, end);
  const body = source.slice(end + 5);
  const frontmatter = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (!key) {
      continue;
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// ─── State ───────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { hashes: {} };
  }
}

async function saveState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Walk vault ──────────────────────────────────────────────────────

async function* walkMarkdown(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip internal bookkeeping dirs — they're locks/state, not content.
      if (entry.name.startsWith(".")) {
        continue;
      }
      yield* walkMarkdown(p);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield p;
    }
  }
}

function slugFromPath(absPath) {
  const rel = path.relative(VAULT_DIR, absPath);
  // Strip .md extension. Flatten subdirectories into the slug via '__' so
  // the slug maps 1:1 to a Firestore document ID (which cannot contain '/').
  // The original path is preserved separately in sourcePath for humans.
  return rel.replace(/\\/g, "/").replace(/\.md$/, "").replace(/\//g, "__");
}

// ─── Scan + diff ─────────────────────────────────────────────────────

async function scanEntries(state) {
  const changed = [];
  let skippedTooLarge = 0;

  for await (const absPath of walkMarkdown(VAULT_DIR)) {
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_MARKDOWN_BYTES) {
      skippedTooLarge += 1;
      continue;
    }
    const raw = await fs.readFile(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const slug = slugFromPath(absPath);
    const localHash = createHash("sha256").update(raw).digest("hex");

    if (state.hashes[slug] === localHash) {
      continue;
    }

    const title =
      (typeof frontmatter.title === "string" && frontmatter.title) ||
      body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      slug;

    changed.push({
      slug,
      title,
      markdown: body,
      frontmatter,
      localHash,
      localMtime: stat.mtime.toISOString(),
      sourcePath: path.relative(path.dirname(VAULT_DIR), absPath),
      ...(INSTANCE_ID ? { sourceInstanceId: INSTANCE_ID } : {}),
    });
  }

  return { changed, skippedTooLarge };
}

// ─── POST in batches ─────────────────────────────────────────────────

async function postBatch(entries) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": INGEST_KEY,
    },
    body: JSON.stringify({ entries }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Ingest failed (${res.status})`);
    err.body = body;
    throw err;
  }
  return body;
}

async function syncOnce() {
  if (!INGEST_KEY) {
    await log("error", "BENCH_WIKI_INGEST_KEY not set — skipping sync");
    return;
  }

  const state = await loadState();
  const { changed, skippedTooLarge } = await scanEntries(state);

  if (changed.length === 0) {
    await log("info", "no changes", { skippedTooLarge });
    return;
  }

  await log("info", "syncing", { count: changed.length, skippedTooLarge });

  for (let i = 0; i < changed.length; i += BATCH_SIZE) {
    const batch = changed.slice(i, i + BATCH_SIZE);
    try {
      const result = await postBatch(batch);
      // Persist hashes only for slugs that the server acknowledged without
      // a parse error. If an entry was rejected we want to retry it later.
      const ack = new Set((result.results ?? []).map((r) => r.slug));
      for (const entry of batch) {
        if (ack.has(entry.slug)) {
          state.hashes[entry.slug] = entry.localHash;
        }
      }
      await log("info", "batch ok", {
        posted: batch.length,
        ingested: result.ingested,
        acknowledged: ack.size,
      });
    } catch (err) {
      await log("error", "batch failed", {
        count: batch.length,
        error: err.message ?? String(err),
        body: err.body,
      });
      // Keep state unchanged so the next run retries.
      break;
    }
  }

  await saveState(state);
}

// ─── Watcher ─────────────────────────────────────────────────────────

function startWatcher() {
  let pending = null;

  const schedule = () => {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(async () => {
      pending = null;
      try {
        await syncOnce();
      } catch (err) {
        await log("error", "sync crashed", { error: err.message ?? String(err) });
      }
    }, DEBOUNCE_MS);
  };

  try {
    watch(VAULT_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".md")) {
        return;
      }
      schedule();
    });
  } catch (err) {
    void log("warn", "recursive watch unsupported — falling back to interval poll", {
      error: err.message ?? String(err),
    });
    setInterval(schedule, 30_000);
  }

  // Kick off an initial sync on startup (catches anything changed while we
  // were stopped).
  schedule();
}

// ─── Main ────────────────────────────────────────────────────────────

(async () => {
  await log("info", "cloud-mirror starting", {
    vault: VAULT_DIR,
    instanceId: INSTANCE_ID ?? null,
    ingestUrl: INGEST_URL,
    hasKey: Boolean(INGEST_KEY),
  });
  startWatcher();
})().catch(async (err) => {
  await log("error", "fatal startup error", { error: err.message ?? String(err) });
  process.exit(1);
});
