#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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
function normalizeRoute(p) {
  const stripped = p.replace(/^\/+|\/+$/g, "");
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

const markdownFiles = allFiles.filter((abs) => /\.(md|mdx)$/i.test(abs));
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

/** @param {string} route */
function resolveRoute(route) {
  let current = normalizeRoute(route);
  if (current === "/") {
    return { ok: true, terminal: "/" };
  }

  const seen = new Set([current]);
  while (redirects.has(current)) {
    current = redirects.get(current);
    if (seen.has(current)) {
      return { ok: false, terminal: current, loop: true };
    }
    seen.add(current);
  }
  return { ok: routes.has(current), terminal: current };
}

const markdownLinkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

/** @type {{file: string; line: number; link: string; reason: string}[]} */
const broken = [];
let checked = 0;

for (const abs of markdownFiles) {
  const rel = normalizeSlashes(path.relative(DOCS_DIR, abs));
  const baseDir = normalizeSlashes(path.dirname(rel));
  const rawText = fs.readFileSync(abs, "utf8");
  const lines = rawText.split("\n");

  // Track if we're inside a code fence
  let inCodeFence = false;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    let line = lines[lineNum];

    // Toggle code fence state
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    // Strip inline code to avoid false positives
    line = stripInlineCode(line);

    for (const match of line.matchAll(markdownLinkRegex)) {
      const raw = match[1]?.trim();
      if (!raw) {
        continue;
      }
      // Skip external links, mailto, tel, data, and same-page anchors
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) {
        continue;
      }

      const [pathPart] = raw.split("#");
      const clean = pathPart.split("?")[0];
      if (!clean) {
        // Same-page anchor only (already skipped above)
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
        // Skip anchor validation - Mintlify generates anchors from MDX components,
        // accordions, and config schemas that we can't reliably extract from markdown.
        continue;
      }

      // Relative placeholder strings used in code examples (for example "url")
      // are intentionally skipped.
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

console.log(`checked_internal_links=${checked}`);
console.log(`broken_links=${broken.length}`);

for (const item of broken) {
  console.log(`${item.file}:${item.line} :: ${item.link} :: ${item.reason}`);
}

if (broken.length > 0) {
  process.exit(1);
}
