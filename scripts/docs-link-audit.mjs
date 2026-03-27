#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const DOCS_JSON_PATH = path.join(DOCS_DIR, "docs.json");

if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) {
  console.error("docs:check-links: missing docs directory; run from repo root.");
  process.exit(1);
}

if (!fs.existsSync(DOCS_JSON_PATH)) {
  console.error("docs:check-links: missing docs/docs.json.");
  process.exit(1);
}

/** @param {string} dir */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** @param {string} p */
function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}

/** @param {string} p */
export function normalizeRoute(p) {
  const [withoutFragment] = p.split("#");
  const [withoutQuery] = withoutFragment.split("?");
  const stripped = withoutQuery.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "/";
}

/** @param {string} text */
function stripInlineCode(text) {
  return text.replace(/`[^`]+`/g, "");
}

const docsConfig = JSON.parse(fs.readFileSync(DOCS_JSON_PATH, "utf8"));
const redirects = new Map();
for (const item of docsConfig.redirects || []) {
  const source = normalizeRoute(String(item.source || ""));
  const destination = normalizeRoute(String(item.destination || ""));
  redirects.set(source, destination);
}

const allFiles = walk(DOCS_DIR);
const relAllFiles = new Set(allFiles.map((abs) => normalizeSlashes(path.relative(DOCS_DIR, abs))));

function isGeneratedTranslatedDoc(relPath) {
  return relPath.startsWith("zh-CN/");
}

const markdownFiles = allFiles.filter((abs) => {
  if (!/\.(md|mdx)$/i.test(abs)) {
    return false;
  }
  const rel = normalizeSlashes(path.relative(DOCS_DIR, abs));
  return !isGeneratedTranslatedDoc(rel);
});
const routes = new Set();

for (const abs of markdownFiles) {
  const rel = normalizeSlashes(path.relative(DOCS_DIR, abs));
  const text = fs.readFileSync(abs, "utf8");
  const slug = rel.replace(/\.(md|mdx)$/i, "");
  const route = normalizeRoute(slug);
  routes.add(route);
  if (slug.endsWith("/index")) {
    routes.add(normalizeRoute(slug.slice(0, -"/index".length)));
  }

  if (!text.startsWith("---")) {
    continue;
  }

  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    continue;
  }
  const frontMatter = text.slice(3, end);
  const match = frontMatter.match(/^permalink:\s*(.+)\s*$/m);
  if (!match) {
    continue;
  }
  const permalink = String(match[1])
    .trim()
    .replace(/^['"]|['"]$/g, "");
  routes.add(normalizeRoute(permalink));
}

/**
 * @param {string} route
 * @param {{redirects?: Map<string, string>, routes?: Set<string>}} [options]
 */
export function resolveRoute(route, options = {}) {
  const redirectMap = options.redirects ?? redirects;
  const publishedRoutes = options.routes ?? routes;
  let current = normalizeRoute(route);
  if (current === "/") {
    return { ok: true, terminal: "/" };
  }

  const seen = new Set([current]);
  while (redirectMap.has(current)) {
    current = normalizeRoute(redirectMap.get(current));
    if (seen.has(current)) {
      return { ok: false, terminal: current, loop: true };
    }
    seen.add(current);
  }
  return { ok: publishedRoutes.has(current), terminal: current };
}

/** @param {unknown} node */
function collectNavPageEntries(node) {
  /** @type {string[]} */
  const entries = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      entries.push(...collectNavPageEntries(item));
    }
    return entries;
  }

  if (!node || typeof node !== "object") {
    return entries;
  }

  const record = /** @type {Record<string, unknown>} */ (node);
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      if (typeof page === "string") {
        entries.push(page);
      } else {
        entries.push(...collectNavPageEntries(page));
      }
    }
  }

  for (const value of Object.values(record)) {
    if (value !== record.pages) {
      entries.push(...collectNavPageEntries(value));
    }
  }

  return entries;
}

const markdownLinkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

export function auditDocsLinks() {
  /** @type {{file: string; line: number; link: string; reason: string}[]} */
  const broken = [];
  let checked = 0;

  for (const abs of markdownFiles) {
    const rel = normalizeSlashes(path.relative(DOCS_DIR, abs));
    const baseDir = normalizeSlashes(path.dirname(rel));
    const rawText = fs.readFileSync(abs, "utf8");
    const lines = rawText.split("\n");

    let inCodeFence = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      let line = lines[lineNum];

      if (line.trim().startsWith("```")) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) {
        continue;
      }

      line = stripInlineCode(line);

      for (const match of line.matchAll(markdownLinkRegex)) {
        const raw = match[1]?.trim();
        if (!raw) {
          continue;
        }
        if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) {
          continue;
        }

        const [pathPart] = raw.split("#");
        const clean = pathPart.split("?")[0];
        if (!clean) {
          continue;
        }
        checked++;

        if (clean.startsWith("/")) {
          const route = normalizeRoute(clean);
          const resolvedRoute = resolveRoute(route);
          if (!resolvedRoute.ok) {
            const staticRel = route.replace(/^\//, "");
            if (!relAllFiles.has(staticRel)) {
              broken.push({
                file: rel,
                line: lineNum + 1,
                link: raw,
                reason: `route/file not found (terminal: ${resolvedRoute.terminal})`,
              });
              continue;
            }
          }
          continue;
        }

        if (!clean.startsWith(".") && !clean.includes("/")) {
          continue;
        }

        const normalizedRel = normalizeSlashes(path.normalize(path.join(baseDir, clean)));

        if (/\.[a-zA-Z0-9]+$/.test(normalizedRel)) {
          if (!relAllFiles.has(normalizedRel)) {
            broken.push({
              file: rel,
              line: lineNum + 1,
              link: raw,
              reason: "relative file not found",
            });
          }
          continue;
        }

        const candidates = [
          normalizedRel,
          `${normalizedRel}.md`,
          `${normalizedRel}.mdx`,
          `${normalizedRel}/index.md`,
          `${normalizedRel}/index.mdx`,
        ];

        if (!candidates.some((candidate) => relAllFiles.has(candidate))) {
          broken.push({
            file: rel,
            line: lineNum + 1,
            link: raw,
            reason: "relative doc target not found",
          });
        }
      }
    }
  }

  for (const page of collectNavPageEntries(docsConfig.navigation || [])) {
    if (isGeneratedTranslatedDoc(String(page))) {
      continue;
    }
    checked++;
    const route = normalizeRoute(page);
    const resolvedRoute = resolveRoute(route);
    if (resolvedRoute.ok) {
      continue;
    }

    broken.push({
      file: "docs.json",
      line: 0,
      link: page,
      reason: `navigation page not published (terminal: ${resolvedRoute.terminal})`,
    });
  }

  return { checked, broken };
}

/**
 * @param {{
 *   args?: string[];
 *   spawnSyncImpl?: typeof spawnSync;
 * }} [options]
 */
export function runDocsLinkAuditCli(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  if (args.includes("--anchors")) {
    const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl("mint", ["broken-links", "--check-anchors"], {
      cwd: DOCS_DIR,
      stdio: "inherit",
    });

    if (result.error?.code === "ENOENT") {
      const fallback = spawnSyncImpl("pnpm", ["dlx", "mint", "broken-links", "--check-anchors"], {
        cwd: DOCS_DIR,
        stdio: "inherit",
      });
      return fallback.status ?? 1;
    }

    return result.status ?? 1;
  }

  const { checked, broken } = auditDocsLinks();
  console.log(`checked_internal_links=${checked}`);
  console.log(`broken_links=${broken.length}`);

  for (const item of broken) {
    console.log(`${item.file}:${item.line} :: ${item.link} :: ${item.reason}`);
  }

  return broken.length > 0 ? 1 : 0;
}

function isCliEntry() {
  const cliArg = process.argv[1];
  return cliArg ? import.meta.url === pathToFileURL(cliArg).href : false;
}

if (isCliEntry()) {
  process.exit(runDocsLinkAuditCli());
}
