#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const I18N_DIR = path.join(ROOT, "docs", ".i18n");
const LIST_ITEM_LINK_RE = /^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)\]\((\/[^)]+)\)/;
const MAX_TITLE_WORDS = 8;
const MAX_LABEL_WORDS = 6;
const MAX_TERM_LENGTH = 80;

/**
 * @typedef {{
 *   file: string;
 *   line: number;
 *   kind: "title" | "link label";
 *   term: string;
 * }} TermMatch
 */

function parseArgs(argv) {
  /** @type {{ base: string; head: string; langs: string[] }} */
  const args = { base: "", head: "", langs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (argv[i] === "--lang") {
      args.langs.push(
        ...(argv[i + 1] ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      i += 1;
    }
  }
  return args;
}

/** Auto-detect languages from glossary.<lang>.json files in docs/.i18n/. */
function detectLangs() {
  return fs
    .readdirSync(I18N_DIR)
    .map((f) => f.match(/^glossary\.(.+)\.json$/)?.[1])
    .filter(Boolean);
}

/** Build a regex that matches English doc paths and excludes translated subdirs. */
function buildDocFileRe(langs) {
  const exclude = langs.map((l) => `(?!${l.replace("-", "\\-")}\\/)`).join("");
  return new RegExp(`^docs\\/${exclude}.+\\.(md|mdx)$`, "i");
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function resolveBase(explicitBase) {
  if (explicitBase) {
    return explicitBase;
  }

  const envBase = process.env.DOCS_I18N_GLOSSARY_BASE?.trim();
  if (envBase) {
    return envBase;
  }

  for (const candidate of ["origin/main", "fork/main", "main"]) {
    try {
      return runGit(["merge-base", candidate, "HEAD"]);
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

function listChangedDocs(base, head, docFileRe) {
  const args = ["diff", "--name-only", "--diff-filter=ACMR", base];
  if (head) {
    args.push(head);
  }
  args.push("--", "docs");

  return runGit(args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => docFileRe.test(line));
}

function loadGlossarySources(lang) {
  const glossaryPath = path.join(I18N_DIR, `glossary.${lang}.json`);
  const data = fs.readFileSync(glossaryPath, "utf8");
  const entries = JSON.parse(data);
  return new Set(entries.map((entry) => String(entry.source || "").trim()).filter(Boolean));
}

function containsLatin(text) {
  return /[A-Za-z]/.test(text);
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function unquoteScalar(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isGlossaryCandidate(term, maxWords) {
  if (!term) {
    return false;
  }
  if (!containsLatin(term)) {
    return false;
  }
  if (term.includes("`")) {
    return false;
  }
  if (term.length > MAX_TERM_LENGTH) {
    return false;
  }
  return wordCount(term) <= maxWords;
}

function readGitFile(base, relPath) {
  try {
    return runGit(["show", `${base}:${relPath}`]);
  } catch {
    return "";
  }
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Map<string, TermMatch>}
 */
function extractTerms(file, text) {
  /** @type {Map<string, TermMatch>} */
  const terms = new Map();
  const lines = text.split("\n");

  if (lines[0]?.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "---") {
        break;
      }

      const match = line.match(/^title:\s*(.+)\s*$/);
      if (!match) {
        continue;
      }

      const title = unquoteScalar(match[1]);
      if (isGlossaryCandidate(title, MAX_TITLE_WORDS)) {
        terms.set(title, { file, line: index + 1, kind: "title", term: title });
      }
      break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(LIST_ITEM_LINK_RE);
    if (!match) {
      continue;
    }

    const label = match[1].trim();
    if (!isGlossaryCandidate(label, MAX_LABEL_WORDS)) {
      continue;
    }

    if (!terms.has(label)) {
      terms.set(label, { file, line: index + 1, kind: "link label", term: label });
    }
  }

  return terms;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const langs = args.langs.length > 0 ? args.langs : detectLangs();

  if (langs.length === 0) {
    console.warn("docs:check-i18n-glossary: no glossary files found; skipping.");
    process.exit(0);
  }

  const base = resolveBase(args.base);

  if (!base) {
    console.warn(
      "docs:check-i18n-glossary: no merge base found; skipping glossary coverage check.",
    );
    process.exit(0);
  }

  const docFileRe = buildDocFileRe(langs);
  const changedDocs = listChangedDocs(base, args.head, docFileRe);
  if (changedDocs.length === 0) {
    process.exit(0);
  }

  // Collect new terms across all changed docs (terms added since base).
  /** @type {Map<string, TermMatch>} */
  const newTerms = new Map();
  for (const relPath of changedDocs) {
    const absPath = path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }
    const currentTerms = extractTerms(relPath, fs.readFileSync(absPath, "utf8"));
    const baseTerms = extractTerms(relPath, readGitFile(base, relPath));
    for (const [term, match] of currentTerms) {
      if (!baseTerms.has(term) && !newTerms.has(term)) {
        newTerms.set(term, match);
      }
    }
  }

  if (newTerms.size === 0) {
    process.exit(0);
  }

  // Check each language's glossary independently.
  /** @type {Map<string, TermMatch[]>} */
  const missingByLang = new Map();
  for (const lang of langs) {
    let glossary;
    try {
      glossary = loadGlossarySources(lang);
    } catch {
      console.warn(`docs:check-i18n-glossary: glossary.${lang}.json not found; skipping ${lang}.`);
      continue;
    }

    const missing = [];
    for (const [term, match] of newTerms) {
      if (!glossary.has(term)) {
        missing.push(match);
      }
    }
    if (missing.length > 0) {
      missingByLang.set(lang, missing);
    }
  }

  if (missingByLang.size === 0) {
    process.exit(0);
  }

  for (const [lang, missing] of missingByLang) {
    console.error(
      `docs:check-i18n-glossary: missing ${lang} glossary entries for changed doc labels:`,
    );
    for (const match of missing) {
      console.error(`- ${match.file}:${match.line} ${match.kind} "${match.term}"`);
    }
    console.error("");
    console.error(
      `Add exact source terms to docs/.i18n/glossary.${lang}.json before rerunning docs-i18n.`,
    );
  }
  console.error(`Checked changed English docs relative to ${base}.`);
  process.exit(1);
}

main();
