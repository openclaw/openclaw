#!/usr/bin/env node
// Periodic mirror: copies Claude Code's per-project auto-memory files into
// the OpenClaw wiki vault as bridge-style source pages, so Aurelius and the
// rest of the crew can absorb them on the next dream cycle.
//
// Direction is one-way (Claude Code -> wiki). Reads still happen on demand
// via openclaw_wiki_search/_get from inside Claude Code. Phase B of the
// workshop unification plan.
//
// Why we don't touch source-sync.json:
//   The bridge's `pruneImportedSourceEntries` only removes entries whose
//   `group` matches "bridge" or "unsafe-local". Files on disk that aren't
//   in state.entries are never pruned by it. The wiki indexer walks the
//   sources/ directory directly (extensions/memory-wiki/src/query.ts:102),
//   so our files are searchable without registration.
//
// File naming: `claude-code-<project-slug>-<file-slug>.md`
//   - Distinct prefix avoids collision with `bridge-<agent>-*.md`
//   - Deterministic (no random hash) so re-runs replace cleanly

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const VAULT_DIR = path.join(HOME, ".openclaw", "wiki", "main");
const SOURCES_DIR = path.join(VAULT_DIR, "sources");
const LOCK_PATH = path.join(VAULT_DIR, ".openclaw-wiki", "locks", "claude-code-mirror.lock");
const LOG_PATH = path.join(HOME, ".openclaw", "logs", "claude-code-mirror.log");
const FILE_PREFIX = "claude-code-";

const MAX_FILE_BYTES = 256 * 1024; // skip giant memory files
const STALE_LOCK_MS = 5 * 60_000;

function slugify(value, max = 60) {
  const lower = value.toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length <= max) {
    return cleaned || "x";
  }
  // truncate but keep an 8-char hash suffix for uniqueness
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, max - 9)}-${hash}`;
}

function decodeProjectName(rawDirName) {
  // Claude Code encodes the cwd as "-Users-coryshelton-..." (slashes -> dashes,
  // leading slash dropped). Reverse it for display, but keep the raw name as
  // the project key (it's stable and unambiguous).
  if (rawDirName.startsWith("-")) {
    return rawDirName.slice(1).replace(/-/g, "/");
  }
  return rawDirName;
}

async function listProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listProjectMemoryFiles(projectDirName) {
  const memoryDir = path.join(PROJECTS_DIR, projectDirName, "memory");
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => ({
      absolutePath: path.join(memoryDir, e.name),
      relativeName: e.name,
    }));
}

function buildPagePath(projectDirName, fileName) {
  const projectSlug = slugify(projectDirName, 60);
  const fileSlug = slugify(fileName.replace(/\.md$/, ""), 40);
  return path.join("sources", `${FILE_PREFIX}${projectSlug}-${fileSlug}.md`);
}

function buildPageId(projectDirName, fileName) {
  const projectHash = createHash("sha256").update(projectDirName).digest("hex").slice(0, 8);
  const fileHash = createHash("sha256").update(fileName).digest("hex").slice(0, 8);
  return `source.claude-code.${projectHash}.${fileName.replace(/\.md$/, "")}-${fileHash}`;
}

function renderSourcePage({ projectDirName, fileName, absolutePath, content, sourceUpdatedAtMs }) {
  const projectDecoded = decodeProjectName(projectDirName);
  const id = buildPageId(projectDirName, fileName);
  const title = `Claude Code Memory (${path.basename(projectDecoded)}): ${fileName.replace(/\.md$/, "")}`;
  const updatedIso = new Date(sourceUpdatedAtMs).toISOString();

  const frontmatter = [
    "---",
    "pageType: source",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    "sourceType: memory-bridge",
    `sourcePath: ${absolutePath}`,
    `bridgeRelativePath: ${fileName}`,
    `bridgeWorkspaceDir: ${path.dirname(absolutePath)}`,
    "bridgeAgentIds:",
    "  - claude-code",
    "status: active",
    `updatedAt: ${updatedIso}`,
    "---",
    "",
  ].join("\n");

  const meta = [
    `# ${title}`,
    "",
    "## Bridge Source",
    `- Workspace: \`${path.dirname(absolutePath)}\``,
    `- Project (decoded): \`${projectDecoded}\``,
    `- Relative path: \`${fileName}\``,
    `- Kind: \`markdown\``,
    `- Agents: claude-code`,
    `- Updated: ${updatedIso}`,
    "",
    "## Content",
    "```markdown",
    content,
    "```",
    "",
  ].join("\n");

  return frontmatter + meta;
}

function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readMaybe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    await fs.writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), {
      flag: "wx",
    });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
    // Lock exists — check if it's stale
    try {
      const raw = await fs.readFile(LOCK_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.at === "number" && Date.now() - parsed.at < STALE_LOCK_MS) {
        return false;
      }
    } catch {
      // unparseable lock file — treat as stale
    }
    await fs.rm(LOCK_PATH, { force: true });
    return acquireLock();
  }
}

async function releaseLock() {
  await fs.rm(LOCK_PATH, { force: true });
}

async function appendLog(line) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    const entry = `${new Date().toISOString()} ${line}\n`;
    await fs.appendFile(LOG_PATH, entry, "utf8");
  } catch {
    // logging is best-effort
  }
}

async function atomicWrite(absolutePath, content) {
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, absolutePath);
}

async function listOurExistingPages() {
  const entries = await fs.readdir(SOURCES_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.startsWith(FILE_PREFIX) && e.name.endsWith(".md"))
    .map((e) => e.name);
}

async function runMirror({ dryRun = false } = {}) {
  await fs.mkdir(SOURCES_DIR, { recursive: true });
  const desiredPages = new Set();
  let mirrored = 0;
  let unchanged = 0;
  let skipped = 0;

  const projects = await listProjects();
  for (const projectDirName of projects) {
    const memFiles = await listProjectMemoryFiles(projectDirName);
    for (const file of memFiles) {
      let stat;
      try {
        stat = await fs.stat(file.absolutePath);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      const content = await readMaybe(file.absolutePath);
      if (content === null || content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const pagePath = buildPagePath(projectDirName, file.relativeName);
      const pageAbs = path.join(VAULT_DIR, pagePath);
      desiredPages.add(path.basename(pagePath));

      const rendered = renderSourcePage({
        projectDirName,
        fileName: file.relativeName,
        absolutePath: file.absolutePath,
        content,
        sourceUpdatedAtMs: stat.mtimeMs,
      });

      const existing = await readMaybe(pageAbs);
      if (existing !== null && fingerprint(existing) === fingerprint(rendered)) {
        unchanged += 1;
        continue;
      }
      if (dryRun) {
        mirrored += 1;
        continue;
      }
      await atomicWrite(pageAbs, rendered);
      mirrored += 1;
    }
  }

  // Prune our orphans (files we own that no longer have a source)
  let pruned = 0;
  const ourPages = await listOurExistingPages();
  for (const pageName of ourPages) {
    if (desiredPages.has(pageName)) {
      continue;
    }
    if (dryRun) {
      pruned += 1;
      continue;
    }
    await fs.rm(path.join(SOURCES_DIR, pageName), { force: true });
    pruned += 1;
  }

  return { mirrored, unchanged, skipped, pruned, scannedProjects: projects.length };
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const verbose = args.has("--verbose") || args.has("-v");
const force = args.has("--force");

if (!force) {
  const got = await acquireLock();
  if (!got) {
    if (verbose) {
      process.stdout.write("another mirror run is in progress; exiting\n");
    }
    process.exit(0);
  }
}

let result;
let error = null;
try {
  result = await runMirror({ dryRun });
} catch (e) {
  error = e;
} finally {
  if (!force) {
    await releaseLock().catch(() => undefined);
  }
}

if (error) {
  await appendLog(`ERROR ${error.stack ?? error.message}`);
  process.stderr.write(`mirror error: ${error.message}\n`);
  process.exit(1);
}

const summary = `mirrored=${result.mirrored} unchanged=${result.unchanged} skipped=${result.skipped} pruned=${result.pruned} projects=${result.scannedProjects}${dryRun ? " (dry-run)" : ""}`;
await appendLog(summary);
if (verbose || dryRun) {
  process.stdout.write(summary + "\n");
}
process.exit(0);
