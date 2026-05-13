#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const defaultTemplatePath = path.join(skillDir, "assets", "audit-viewer.html");
const ACTIONS = new Set(["retained", "paraphrase", "moved", "split", "merged", "removed"]);
const REASONS = new Set([
  "same-scope",
  "redundant",
  "verbose",
  "mis-categorized",
  "generated-source",
  "obsolete",
  "unsupported",
  "duplicate-linking",
  "nav-only",
]);
const STATUSES = new Set([
  "covered",
  "partially-covered",
  "missing",
  "intentionally-removed",
  "needs-source-check",
]);
const REMOVED_REASONS_REQUIRING_TARGETS = new Set(["generated-source", "redundant"]);
const LOW_OVERLAP_MIN_TOKENS = 5;
const CURRENT_SCHEMA_VERSION = 3;
const BOOLEAN_ARGS = new Set(["changed-only"]);

function usage() {
  console.error(`Usage:
  audit-report-viewer.mjs --report <detailed-report.md> --out-dir <dir> [--basename <name>] [--source-ref <git-ref[:path]>]
  audit-report-viewer.mjs --data <audit-data.json> --html-out <viewer.html> [--detailed-out <detailed.md>]
  audit-report-viewer.mjs scaffold --source-ref <git-ref> --source-pages <csv> --json-out <draft.json>
  audit-report-viewer.mjs migrate-v1 --report <detailed-report.md> --json-out <draft.json>
  audit-report-viewer.mjs validate --data <audit-data.json> [--changed-only] [--diff-base <git-ref>]
  audit-report-viewer.mjs hydrate --data <draft.json> --json-out <hydrated.json> [--changed-pages <csv>]
  audit-report-viewer.mjs render --data <audit-data.json> --html-out <viewer.html> [--detailed-out <detailed.md>]

Options:
  --report <path>       Detailed audit markdown table to convert into JSON.
  --data <path>         Existing audit JSON to render.
  --out-dir <dir>       Directory for <basename>-audit-data.json and <basename>-audit-viewer.html.
  --basename <name>     Output basename. Defaults from --report.
  --json-out <path>     Explicit JSON output path.
  --html-out <path>     Explicit HTML output path.
  --detailed-out <path> Optional normalized detailed markdown output path.
  --changed-pages <csv> Markdown docs pages changed by the PR. Adds destination-page selector views.
  --source-ref <ref>    Source archive git ref or gitRef:path. Defaults from report frontmatter source_ref.
  --source-pages <csv>  Source page paths for scaffold.
  --changed-only        Validate only mappings affected by changed destination files/hunks.
  --diff-base <ref>     Base ref for --changed-only diff. Defaults to HEAD.
  --template <path>     HTML template. Defaults to this skill's assets/audit-viewer.html.
  --cwd <path>          Repo root. Defaults to process.cwd().
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      if (BOOLEAN_ARGS.has(key)) {
        args[key] = true;
        continue;
      }
      throw new Error(`Missing value for ${token}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function resolveFrom(cwd, value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: text };
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return { frontmatter, body };
}

function parseSourceArchive(value) {
  const sourceRef = value || "";
  const colon = sourceRef.lastIndexOf(":");
  if (colon > 0) {
    const right = sourceRef.slice(colon + 1);
    if (/^[^:]+\.(?:md|mdx|ts|tsx|js|mjs|json|json5)$/.test(right) || right.includes("/")) {
      return {
        label: "<SOURCE_REF_OR_ARCHIVE>",
        ref: sourceRef,
        gitRef: sourceRef.slice(0, colon),
        path: right,
      };
    }
  }
  return {
    label: "<SOURCE_REF_OR_ARCHIVE>",
    ref: sourceRef,
    gitRef: sourceRef,
    path: null,
  };
}

function splitTableRow(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function cleanMarkdownInline(text) {
  return String(text || "")
    .replace(/<br \/>/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseRef(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/^`|`$/g, "");
  const match = text.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  return {
    path: match[1],
    start: Number(match[2]),
    end: Number(match[3] || match[2]),
  };
}

function getSourceLines(ref, sourceArchive, cwd, cache) {
  if (!ref || !sourceArchive.gitRef) return [];
  const key = `${sourceArchive.gitRef}:${ref.path}`;
  if (!cache.has(key)) {
    try {
      cache.set(
        key,
        execFileSync("git", ["show", key], {
          cwd,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
        }).split(/\r?\n/),
      );
    } catch {
      cache.set(key, []);
    }
  }
  return linesForRange(cache.get(key), ref);
}

function getSourceDocumentLines(pagePath, sourceArchive, cwd, cache) {
  if (!pagePath || !sourceArchive.gitRef) return [];
  const key = `${sourceArchive.gitRef}:${pagePath}`;
  if (!cache.has(key)) {
    try {
      cache.set(
        key,
        execFileSync("git", ["show", key], {
          cwd,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
        }).split(/\r?\n/),
      );
    } catch {
      cache.set(key, []);
    }
  }
  return cache.get(key).map((text, index) => ({
    number: index + 1,
    text,
  }));
}

function getCurrentLines(ref, cwd) {
  if (!ref) return [];
  const filePath = path.join(cwd, ref.path);
  if (!fs.existsSync(filePath)) return [];
  return linesForRange(fs.readFileSync(filePath, "utf8").split(/\r?\n/), ref);
}

function fileChangedSinceSource(ref, sourceArchive, cwd, cache) {
  if (!ref || !sourceArchive.gitRef) return true;
  if (cache.has(ref.path)) return cache.get(ref.path);
  let changed = true;
  try {
    execFileSync("git", ["diff", "--quiet", sourceArchive.gitRef, "--", ref.path], {
      cwd,
      stdio: "ignore",
    });
    changed = false;
  } catch {
    changed = true;
  }
  cache.set(ref.path, changed);
  return changed;
}

function linesForRange(lines, ref) {
  if (!lines || !lines.length || !ref) return [];
  return lines.slice(ref.start - 1, ref.end).map((text, index) => ({
    number: ref.start + index,
    text,
  }));
}

function parseDestinations(cell, options) {
  const { changedFileCache, cwd, sourceArchive } = options;
  if (!cell || !cell.trim()) return [];
  return cell
    .split(/<br \/>/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const refMatch = part.match(/`([^`]+)`/);
      const ref = refMatch ? parseRef(refMatch[1]) : null;
      const generatorMatch = part.match(/generated by `([^`]+)`/);
      const generator = generatorMatch ? parseRef(generatorMatch[1]) : null;
      const note = cleanMarkdownInline(
        part.replace(/`[^`]+`/g, "").replace(/\(generated by [^)]+\)/g, ""),
      );
      return {
        changedSinceSource: fileChangedSinceSource(ref, sourceArchive, cwd, changedFileCache),
        external: !ref,
        generator,
        generatorLines: getCurrentLines(generator, cwd),
        lines: getCurrentLines(ref, cwd),
        note,
        raw: part,
        ref,
      };
    });
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((page) => page.trim())
    .filter(Boolean);
}

function parseChangedPages(value) {
  return parseCsv(value).filter((page) => page.endsWith(".md") || page.endsWith(".mdx"));
}

function unitTouchesDestinationPage(unit, page) {
  return unit.destinations.some((destination) => destination.ref?.path === page);
}

function buildPageViews(pages, changedPages) {
  const units = pages.flatMap((page) => page.units);
  const sourcePages = new Set(pages.map((page) => page.page));
  const destinationPages = new Set(
    units.flatMap((unit) =>
      unit.destinations.map((destination) => destination.ref?.path).filter(Boolean),
    ),
  );
  const orderedPages = changedPages.length
    ? changedPages
    : [...sourcePages, ...[...destinationPages].filter((page) => !sourcePages.has(page))];
  const views = [];
  const seen = new Set();

  for (const page of orderedPages) {
    if (seen.has(page)) continue;
    seen.add(page);
    if (sourcePages.has(page)) {
      const sourcePage = pages.find((candidate) => candidate.page === page);
      views.push({
        count: sourcePage.units.length,
        id: `source:${page}`,
        kind: "source",
        label: page,
        page,
      });
      continue;
    }
    if (destinationPages.has(page)) {
      views.push({
        count: units.filter((unit) => unitTouchesDestinationPage(unit, page)).length,
        id: `destination:${page}`,
        kind: "destination",
        label: page,
        page,
      });
    }
  }

  if (!views.length && pages[0]) {
    views.push({
      count: pages[0].units.length,
      id: `source:${pages[0].page}`,
      kind: "source",
      label: pages[0].page,
      page: pages[0].page,
    });
  }
  return views;
}

function parseDetailedReport(reportPath, options) {
  const cwd = options.cwd;
  const text = fs.readFileSync(reportPath, "utf8");
  const { frontmatter } = parseFrontmatter(text);
  const sourceArchive = parseSourceArchive(options.sourceRef || frontmatter.source_ref);
  const changedFileCache = new Map();
  const sourceCache = new Map();
  const pagesByName = new Map();
  let currentPage = sourceArchive.path || "unknown";

  function pageRecord(pageName) {
    if (!pagesByName.has(pageName)) {
      pagesByName.set(pageName, {
        count: 0,
        coverage: `Paragraph-level audit of all original content units.`,
        counters: null,
        page: pageName,
        units: [],
      });
    }
    return pagesByName.get(pageName);
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+\.(?:md|mdx))\s*$/);
    if (heading) {
      currentPage = heading[1];
      pageRecord(currentPage);
      continue;
    }

    const coverageCells = splitTableRow(line);
    if (coverageCells.length === 2 && /^`[^`]+\.(?:md|mdx)`$/.test(coverageCells[0])) {
      const pageName = coverageCells[0].slice(1, -1);
      pageRecord(pageName).coverage = cleanMarkdownInline(coverageCells[1]);
      currentPage = pageName;
      continue;
    }

    if (/^\| P\d{3}: /.test(line)) {
      const cells = splitTableRow(line);
      if (cells.length !== 8) {
        throw new Error(`Expected 8 table cells, got ${cells.length}: ${line}`);
      }
      const idLabel = cells[0].match(/^(P\d{3}):\s*(.*)$/);
      const sourceMatch = cells[1].match(/`([^`]+)`\s+from\s+`<SOURCE_REF_OR_ARCHIVE>`/);
      const sourceRef = sourceMatch ? parseRef(sourceMatch[1]) : null;
      const pageName = sourceRef?.path || currentPage;
      const page = pageRecord(pageName);
      page.units.push({
        action: cleanMarkdownInline(cells[3]),
        destinations: parseDestinations(cells[5], {
          changedFileCache,
          cwd,
          sourceArchive,
        }),
        id: idLabel?.[1] || "",
        label: cleanMarkdownInline(idLabel?.[2] || ""),
        markdown: {
          action: cells[3],
          destination: cells[5],
          id: cells[0],
          notes: cells[7],
          reason: cells[4],
          source: cells[1],
          status: cells[6],
          summary: cells[2],
        },
        notes: cleanMarkdownInline(cells[7]),
        page: pageName,
        reason: cleanMarkdownInline(cells[4]),
        source: {
          archive: sourceArchive.gitRef,
          lines: getSourceLines(sourceRef, sourceArchive, cwd, sourceCache),
          ref: sourceRef,
        },
        status: cleanMarkdownInline(cells[6]),
        summary: cleanMarkdownInline(cells[2]),
      });
      currentPage = pageName;
      continue;
    }

    const counters = line.match(/^source_units=(\d+)\s+audited_units=(\d+)\s+gaps=(.+)$/);
    if (counters) {
      pageRecord(currentPage).counters = {
        auditedUnits: Number(counters[2]),
        gaps: counters[3],
        sourceUnits: Number(counters[1]),
      };
    }
  }

  const pages = Array.from(pagesByName.values()).filter((page) => page.units.length > 0);
  for (const page of pages) {
    page.count = page.units.length;
    page.sourceDocument = {
      lines: getSourceDocumentLines(page.page, sourceArchive, cwd, sourceCache),
      ref: {
        archive: sourceArchive.gitRef,
        path: page.page,
      },
    };
  }
  const title = options.title || frontmatter.title || "Docs Rewrite Audit";
  const changedPages = parseChangedPages(options.changedPages);
  return {
    changedPages,
    frontmatter,
    generatedAt: new Date().toISOString(),
    generator: {
      name: "openclaw-docs-audit audit-report-viewer",
      script: path.relative(cwd, fileURLToPath(import.meta.url)),
    },
    schemaVersion: 1,
    sourceArchive,
    sourceReport: path.relative(cwd, reportPath),
    title,
    viewerTitle: title
      .replace(/\s+Paragraph Rewrite Audit$/, "")
      .replace(/\s+Rewrite Audit$/, " Migration Map"),
    pageViews: buildPageViews(pages, changedPages),
    pages,
  };
}

function sourceArchiveForData(data) {
  if (data.sourceArchive?.gitRef) return data.sourceArchive;
  const sourceRef = data.audit?.sourceRef || data.sourceRef || "";
  const firstPage = data.audit?.sourcePages?.[0] || data.pages?.[0]?.page || null;
  const parsed = parseSourceArchive(sourceRef);
  if (!parsed.path && firstPage) {
    return {
      ...parsed,
      path: firstPage,
      ref: [parsed.gitRef, firstPage].filter(Boolean).join(":"),
    };
  }
  return parsed;
}

function sourcePagesForData(data) {
  if (Array.isArray(data.audit?.sourcePages) && data.audit.sourcePages.length) {
    return data.audit.sourcePages;
  }
  return [...new Set((data.pages || []).map((page) => page.page).filter(Boolean))];
}

function inferAuditId(data, fallback = "docs-audit") {
  if (data.audit?.id) return data.audit.id;
  if (data.sourceReport) return defaultBasename(data.sourceReport);
  const page = sourcePagesForData(data)[0];
  if (!page) return fallback;
  return page
    .replace(/\.(md|mdx)$/u, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cloneRef(ref) {
  if (!ref) return null;
  return {
    path: ref.path,
    start: Number(ref.start),
    end: Number(ref.end || ref.start),
  };
}

function destinationTargetFromDestination(destination) {
  if (!destination?.ref) return null;
  const target = {
    ref: cloneRef(destination.ref),
  };
  if (destination.role) target.role = destination.role;
  if (destination.justification || destination.notes || destination.note) {
    target.justification = destination.justification || destination.notes || destination.note;
  }
  return target;
}

function destinationTargetsFromUnit(unit) {
  return (unit.destinations || [])
    .map((destination) => destinationTargetFromDestination(destination))
    .filter(Boolean);
}

function isFormattingOnlyLine(text) {
  return !String(text || "").trim();
}

function compactText(text, maxLength = 120) {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxLength) return compact;
  return compact.slice(0, maxLength - 1).trimEnd() + "...";
}

function targetJustification(target, line, unit) {
  const existing = target?.justification || target?.notes || target?.note;
  if (existing && String(existing).trim()) return String(existing).trim();
  const sourceLabel = `${unit?.id || "source"}:${line.number}`;
  const sourceText = compactText(line.text);
  if (target?.mapping === "auto-line-overlap") {
    return `Auto line-overlap match for ${sourceLabel}: ${sourceText}`;
  }
  if (target?.mapping === "block-fallback") {
    return `Fallback to the unit destination for ${sourceLabel}; review exact claim equivalence: ${sourceText}`;
  }
  if (target?.mapping === "manual-line" || target?.mapping === "semantic-confirmed") {
    return `Manual claim mapping for ${sourceLabel}: ${sourceText}`;
  }
  return `Line target for ${sourceLabel}: ${sourceText}`;
}

function withTargetJustification(target, line, unit) {
  const { note, notes, ...cleanTarget } = target || {};
  return {
    ...cleanTarget,
    justification: targetJustification(target, line, unit),
  };
}

function lineTargetsForUnit(unit, line) {
  if (line.action === "removed" && !REMOVED_REASONS_REQUIRING_TARGETS.has(line.reason)) {
    return [];
  }
  const narrowedTargets = autoLineTargetsForUnit(unit, line);
  if (narrowedTargets.length) return narrowedTargets;
  return destinationTargetsFromUnit(unit)
    .map((target) => ({
      ...target,
      mapping: "block-fallback",
    }))
    .map((target) => withTargetJustification(target, line, unit));
}

function autoLineTargetsForUnit(unit, line) {
  if (isFormattingOnlyLine(line.text)) return [];
  const sourceTokens = normalizeTokenText(line.text);
  if (sourceTokens.length < LOW_OVERLAP_MIN_TOKENS) return [];
  const targets = [];
  for (const destination of unit.destinations || []) {
    if (!destination.ref || !Array.isArray(destination.lines) || !destination.lines.length)
      continue;
    const matched = destination.lines
      .map((destinationLine) => ({
        line: destinationLine,
        score: tokenOverlapScore(line.text, destinationLine.text),
      }))
      .filter((candidate) => candidate.score >= 0.35);
    if (!matched.length) continue;
    const groups = contiguousLineGroups(matched.map((candidate) => candidate.line.number));
    for (const group of groups) {
      targets.push({
        justification: `Auto line-overlap match for ${unit.id}:${line.number}: ${compactText(line.text)}`,
        mapping: "auto-line-overlap",
        ref: {
          path: destination.ref.path,
          start: group.start,
          end: group.end,
        },
      });
    }
  }
  return targets;
}

function contiguousLineGroups(numbers) {
  const ordered = [...new Set(numbers)].sort((left, right) => left - right);
  const groups = [];
  for (const number of ordered) {
    const last = groups[groups.length - 1];
    if (last && number === last.end + 1) {
      last.end = number;
    } else {
      groups.push({ start: number, end: number });
    }
  }
  return groups;
}

function migrateV1ToV3(v1Data) {
  if (v1Data.schemaVersion !== 1) {
    throw new Error("migrate-v1 expects schemaVersion 1 input.");
  }
  const sourceArchive = sourceArchiveForData(v1Data);
  const audit = {
    id: inferAuditId(v1Data),
    sourcePages: sourcePagesForData(v1Data),
    sourceRef: sourceArchive.gitRef || sourceArchive.ref || "",
    spec: v1Data.frontmatter?.spec,
    title: v1Data.title || "Docs Rewrite Audit",
  };
  const pages = v1Data.pages.map((page) => ({
    counters: page.counters || null,
    count: page.units.length,
    coverage: page.coverage || "Paragraph-level audit of all original content units.",
    page: page.page,
    sourceDocument: page.sourceDocument
      ? {
          ref: page.sourceDocument.ref,
          lines: page.sourceDocument.lines || [],
        }
      : undefined,
    sourceUnits: page.counters?.sourceUnits || page.units.length,
    units: page.units.map((unit) => {
      const destinations = (unit.destinations || []).map((destination) => ({
        external: Boolean(destination.external),
        generator: cloneRef(destination.generator),
        notes: destination.note || destination.notes || "",
        raw: destination.raw,
        ref: cloneRef(destination.ref),
        role: destination.role || "primary",
      }));
      const draftUnit = {
        action: unit.action,
        destinations,
        id: unit.id,
        label: unit.label,
        notes: unit.notes,
        page: unit.page,
        reason: unit.reason,
        source: {
          archive: unit.source?.archive || sourceArchive.gitRef,
          ref: cloneRef(unit.source?.ref),
          lines: [],
        },
        status: unit.status,
        summary: unit.summary,
      };
      draftUnit.source.lines = (unit.source?.lines || []).map((line) => {
        const formattingOnly = isFormattingOnlyLine(line.text);
        const lineDecision = {
          action: formattingOnly ? "removed" : unit.action,
          notes: formattingOnly
            ? "Formatting-only source line; no destination needed."
            : unit.notes || "",
          number: line.number,
          reason: formattingOnly ? "verbose" : unit.reason,
          status: formattingOnly ? "intentionally-removed" : unit.status,
          targets: [],
          text: line.text,
        };
        lineDecision.targets = lineTargetsForUnit(
          {
            ...draftUnit,
            destinations: unit.destinations || [],
          },
          lineDecision,
        );
        return lineDecision;
      });
      return draftUnit;
    }),
  }));
  return {
    audit,
    changedPages: v1Data.changedPages || [],
    frontmatter: v1Data.frontmatter || {},
    pageViews: v1Data.pageViews || buildPageViews(pages, v1Data.changedPages || []),
    pages,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourceArchive: {
      ...sourceArchive,
      ref:
        sourceArchive.ref || [sourceArchive.gitRef, sourceArchive.path].filter(Boolean).join(":"),
    },
    sourceReport: v1Data.sourceReport,
    title: audit.title,
    viewerTitle: v1Data.viewerTitle || audit.title,
  };
}

function classifyMarkdownBlock(lines, start, end) {
  const first = lines[start - 1]?.text || "";
  if (start === 1 && first === "---") return "Frontmatter metadata";
  if (/^#{1,6}\s+/.test(first)) return first.replace(/^#{1,6}\s+/, "").trim() || "Heading";
  if (/^```/.test(first)) return "Code block";
  if (/^\s*[-*+]\s+/.test(first) || /^\s*\d+\.\s+/.test(first)) return "List";
  if (/^\s*\|/.test(first)) return "Table";
  if (/^\s*>/.test(first)) return "Admonition or quote";
  if (/^\s*<\/?[A-Z][A-Za-z0-9]*/.test(first)) return "MDX block";
  return `Source block ${start}-${end}`;
}

function markdownBlocks(documentLines) {
  const blocks = [];
  let start = null;
  let inFence = false;
  let inFrontmatter = false;

  function close(end) {
    if (start !== null && end >= start) {
      blocks.push({
        end,
        label: classifyMarkdownBlock(documentLines, start, end),
        start,
      });
    }
    start = null;
  }

  for (let index = 0; index < documentLines.length; index += 1) {
    const number = index + 1;
    const text = documentLines[index].text;
    if (number === 1 && text === "---") {
      start = 1;
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (text === "---") {
        close(number);
        inFrontmatter = false;
      }
      continue;
    }
    if (inFence) {
      if (/^```/.test(text)) {
        inFence = false;
        close(number);
      }
      continue;
    }
    if (/^```/.test(text)) {
      close(number - 1);
      start = number;
      inFence = true;
      continue;
    }
    if (!text.trim()) {
      close(number - 1);
      continue;
    }
    if (/^#{1,6}\s+/.test(text)) {
      close(number - 1);
      start = number;
      close(number);
      continue;
    }
    if (start === null) start = number;
  }
  close(documentLines.length);
  return blocks;
}

function scaffoldV2(options) {
  const sourceArchive = parseSourceArchive(options.sourceRef);
  if (!sourceArchive.gitRef) throw new Error("scaffold requires --source-ref.");
  const sourcePages = parseCsv(options.sourcePages);
  if (!sourcePages.length) throw new Error("scaffold requires --source-pages.");
  const sourceCache = new Map();
  const pages = sourcePages.map((pagePath) => {
    const sourceDocumentLines = getSourceDocumentLines(
      pagePath,
      sourceArchive,
      options.cwd,
      sourceCache,
    );
    const blocks = markdownBlocks(sourceDocumentLines);
    const units = blocks.map((block, index) => ({
      action: "",
      destinations: [],
      id: `P${String(index + 1).padStart(3, "0")}`,
      label: block.label,
      notes: "",
      page: pagePath,
      reason: "",
      source: {
        archive: sourceArchive.gitRef,
        ref: {
          path: pagePath,
          start: block.start,
          end: block.end,
        },
        lines: sourceDocumentLines.slice(block.start - 1, block.end).map((line) => ({
          action: "",
          notes: "",
          number: line.number,
          reason: "",
          status: "",
          targets: [],
          text: line.text,
        })),
      },
      status: "",
      summary: "",
    }));
    return {
      count: units.length,
      coverage: "Paragraph-level audit of all original content units.",
      page: pagePath,
      sourceDocument: {
        ref: {
          archive: sourceArchive.gitRef,
          path: pagePath,
        },
        lines: sourceDocumentLines,
      },
      sourceUnits: units.length,
      units,
    };
  });
  const title = options.title || `${sourcePages[0]} Rewrite Audit`;
  return {
    audit: {
      id: options.id || sourcePages[0].replace(/\.(md|mdx)$/u, "").replace(/[^A-Za-z0-9]+/g, "-"),
      sourcePages,
      sourceRef: sourceArchive.gitRef,
      spec: options.spec,
      title,
    },
    changedPages: [],
    frontmatter: {
      schema: "ag-dir-v2",
      status: "draft",
    },
    pages,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourceArchive: {
      ...sourceArchive,
      path: sourceArchive.path || sourcePages[0],
      ref: sourceArchive.ref || [sourceArchive.gitRef, sourcePages[0]].join(":"),
    },
    title,
    viewerTitle: title.replace(/\s+Rewrite Audit$/, " Migration Map"),
  };
}

function currentRangeExists(ref, cwd) {
  return Boolean(ref && getCurrentLines(ref, cwd).length === ref.end - ref.start + 1);
}

function sourceRangeExists(ref, sourceArchive, cwd, cache) {
  return Boolean(
    ref && getSourceLines(ref, sourceArchive, cwd, cache).length === ref.end - ref.start + 1,
  );
}

function hydrateTargets(targets, cwd, line, unit) {
  return (targets || []).map((target) => {
    const ref = cloneRef(target.ref);
    const hydrated = {
      ...withTargetJustification(target, line, unit),
      ref,
    };
    if (ref) hydrated.lines = getCurrentLines(ref, cwd);
    return hydrated;
  });
}

function hydrateV2(data, options) {
  if (![2, 3].includes(data.schemaVersion)) {
    throw new Error("hydrate expects schemaVersion 2 or 3 data.");
  }
  const sourceArchive = sourceArchiveForData(data);
  const sourceCache = new Map();
  const changedFileCache = new Map();
  const changedPages =
    parseChangedPages(options.changedPages).length > 0
      ? parseChangedPages(options.changedPages)
      : data.changedPages || [];
  const pages = data.pages.map((page) => {
    const sourceDocumentLines = getSourceDocumentLines(
      page.page,
      sourceArchive,
      options.cwd,
      sourceCache,
    );
    const hydratedPage = {
      ...page,
      count: page.units.length,
      sourceDocument: {
        ref: {
          archive: sourceArchive.gitRef,
          path: page.page,
        },
        lines: sourceDocumentLines,
      },
      sourceUnits: page.sourceUnits || page.counters?.sourceUnits || page.units.length,
    };
    hydratedPage.units = page.units.map((unit) => {
      const sourceRef = cloneRef(unit.source?.ref);
      const sourceLines = sourceRef
        ? getSourceLines(sourceRef, sourceArchive, options.cwd, sourceCache)
        : [];
      const existingLinesByNumber = new Map(
        (unit.source?.lines || []).map((line) => [Number(line.number), line]),
      );
      const hydratedDestinations = (unit.destinations || []).map((destination) => {
        const ref = cloneRef(destination.ref);
        const generator = cloneRef(destination.generator);
        return {
          ...destination,
          changedSinceSource: fileChangedSinceSource(
            ref,
            sourceArchive,
            options.cwd,
            changedFileCache,
          ),
          external: Boolean(destination.external || !ref),
          generator,
          generatorLines: getCurrentLines(generator, options.cwd),
          lines: getCurrentLines(ref, options.cwd),
          note: destination.note || destination.notes || "",
          notes: destination.notes || destination.note || "",
          raw: destination.raw,
          ref,
          role: destination.role || "primary",
        };
      });
      const unitForTargets = {
        ...unit,
        destinations: hydratedDestinations,
        page: unit.page || page.page,
      };
      const hydratedUnit = {
        ...unitForTargets,
        source: {
          archive: sourceArchive.gitRef,
          ref: sourceRef,
          lines: sourceLines.map((line) => {
            const existing = existingLinesByNumber.get(line.number) || {};
            const action = existing.action || unit.action || "";
            const reason = existing.reason || unit.reason || "";
            const status = existing.status || unit.status || "";
            const draftLine = {
              action,
              notes: existing.notes || "",
              number: line.number,
              reason,
              status,
              targets: hydrateTargets(existing.targets || [], options.cwd, existing, unit),
              text: line.text,
            };
            if (!draftLine.targets.length && !isFormattingOnlyLine(line.text)) {
              draftLine.targets = hydrateTargets(
                lineTargetsForUnit(unitForTargets, draftLine),
                options.cwd,
                draftLine,
                unitForTargets,
              );
            }
            return draftLine;
          }),
        },
      };
      return hydratedUnit;
    });
    return hydratedPage;
  });
  const hydrated = {
    ...data,
    changedPages,
    generatedAt: new Date().toISOString(),
    generator: {
      name: "openclaw-docs-audit audit-report-viewer",
      script: path.relative(options.cwd, fileURLToPath(import.meta.url)),
    },
    pageViews: buildPageViews(pages, changedPages),
    pages,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourceArchive: {
      ...sourceArchive,
      path: sourceArchive.path || sourcePagesForData(data)[0] || null,
      ref:
        sourceArchive.ref ||
        [sourceArchive.gitRef, sourceArchive.path || sourcePagesForData(data)[0]]
          .filter(Boolean)
          .join(":"),
    },
    title: data.title || data.audit?.title || "Docs Rewrite Audit",
    viewerTitle:
      data.viewerTitle ||
      (data.title || data.audit?.title || "Docs Rewrite Audit")
        .replace(/\s+Paragraph Rewrite Audit$/, "")
        .replace(/\s+Rewrite Audit$/, " Migration Map"),
  };
  hydrated.validation = collectValidation(hydrated, {
    cwd: options.cwd,
    hydrated: true,
  });
  return hydrated;
}

function normalizeTokenText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`*_()[\]{}<>|:;,.!?/\\-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .filter(
      (token) =>
        !new Set(["the", "and", "for", "with", "from", "that", "this", "into", "when"]).has(token),
    );
}

function lineTargetText(targets, cwd) {
  return (targets || [])
    .flatMap((target) => target.lines || getCurrentLines(target.ref, cwd))
    .map((line) => line.text)
    .join("\n");
}

function currentDocumentLines(pagePath, cwd, cache) {
  if (!pagePath) return [];
  if (cache?.has(pagePath)) return cache.get(pagePath);
  const filePath = path.join(cwd, pagePath);
  const lines = fs.existsSync(filePath)
    ? fs
        .readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((text, index) => ({
          number: index + 1,
          text,
        }))
    : [];
  if (cache) cache.set(pagePath, lines);
  return lines;
}

function tokenOverlapScore(sourceText, targetText) {
  const sourceTokens = normalizeTokenText(sourceText);
  if (sourceTokens.length < LOW_OVERLAP_MIN_TOKENS) return 1;
  const targetTokens = new Set(normalizeTokenText(targetText));
  if (!targetTokens.size) return 0;
  const matches = sourceTokens.filter((token) => targetTokens.has(token)).length;
  return matches / sourceTokens.length;
}

function isStrongFactLine(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (
    /^[-*]?\s*(`[^`]+`|\w+(?:\.\w+)+|[A-Z0-9_]+)\s*[:=|]/.test(value) ||
    /^\|/.test(value) ||
    /^#{1,6}\s/.test(value) ||
    /^<\/?[A-Z][A-Za-z]*(\s|>)/.test(value) ||
    /^```/.test(value)
  ) {
    return false;
  }
  return /\b(default|enabled|disabled|enable|disable|deny|allow|wins|force-enable|auto-?activate|auto-?enable|preserved|preserves|re-enable|fails closed|skips|cleanup|exclusive|selected|opt-in|legacy|canonical|boundary|must|only|require|required)\b/i.test(
    value,
  );
}

function changedDestinationIndex(cwd, diffBase = "HEAD") {
  let diffText = "";
  try {
    diffText = execFileSync("git", ["diff", "--unified=0", diffBase, "--", "docs"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    diffText = "";
  }
  const files = new Map();
  let currentPath = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const nextPath = line.replace(/^\+\+\+\s+b\//, "").trim();
      currentPath =
        nextPath && nextPath !== "/dev/null" && /\.(md|mdx)$/u.test(nextPath) ? nextPath : null;
      continue;
    }
    if (!currentPath) continue;
    const hunk = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!hunk) continue;
    const start = Math.max(1, Number(hunk[1]));
    const current = files.get(currentPath);
    files.set(currentPath, {
      firstChangedLine: current ? Math.min(current.firstChangedLine, start) : start,
      path: currentPath,
    });
  }
  return {
    diffBase,
    files,
  };
}

function refAffectedByChangedIndex(ref, changedIndex) {
  if (!ref || !changedIndex?.files?.has(ref.path)) return false;
  return Number(ref.end || ref.start) >= changedIndex.files.get(ref.path).firstChangedLine;
}

function unitAffectedByChangedIndex(unit, changedIndex) {
  if (!changedIndex) return true;
  return (
    (unit.destinations || []).some((destination) =>
      refAffectedByChangedIndex(destination.ref, changedIndex),
    ) ||
    (unit.source?.lines || []).some((line) =>
      (line.targets || []).some((target) => refAffectedByChangedIndex(target.ref, changedIndex)),
    )
  );
}

function bestLineMatch(sourceText, pagePath, cwd, cache) {
  const sourceTokens = normalizeTokenText(sourceText);
  if (sourceTokens.length < LOW_OVERLAP_MIN_TOKENS) return null;
  const normalizedSource = sourceTokens.join(" ");
  let best = null;
  for (const line of currentDocumentLines(pagePath, cwd, cache)) {
    const normalizedCandidate = normalizeTokenText(line.text).join(" ");
    const exact = normalizedCandidate && normalizedCandidate === normalizedSource;
    const score = exact ? 1 : tokenOverlapScore(sourceText, line.text);
    if (!best || score > best.score) {
      best = {
        ref: {
          path: pagePath,
          start: line.number,
          end: line.number,
        },
        score,
        text: line.text,
      };
    }
  }
  if (!best || best.score < 0.6) return null;
  return best;
}

function collectValidation(data, options = {}) {
  const errors = [];
  const warnings = [];
  const sourceArchive = sourceArchiveForData(data);
  const sourceCache = new Map();
  const currentCache = new Map();
  const changedIndex =
    options.changedOnly && options.cwd
      ? changedDestinationIndex(options.cwd, options.diffBase || "HEAD")
      : null;
  const scope = changedIndex
    ? {
        affectedFiles: Array.from(changedIndex.files.values()),
        checkedUnits: 0,
        changedOnly: true,
        diffBase: changedIndex.diffBase,
        skippedUnits: 0,
      }
    : undefined;
  const pages = data.pages || [];
  if (![1, 2, 3].includes(data.schemaVersion)) {
    errors.push({
      code: "schema-version",
      message: `Expected schemaVersion 1, 2, or 3, got ${data.schemaVersion}.`,
    });
    return { errors, warnings };
  }
  if (!pages.length) {
    errors.push({ code: "missing-pages", message: "Audit data has no pages." });
  }
  const units = pages.flatMap((page) => page.units || []);
  if (!units.length) {
    errors.push({ code: "missing-units", message: "Audit data has no units." });
  }
  for (const page of pages) {
    const seenUnitIds = new Set();
    let lastStart = 0;
    for (const unit of page.units || []) {
      if (seenUnitIds.has(unit.id)) {
        errors.push({
          code: "duplicate-unit-id",
          message: `${page.page} has duplicate unit id ${unit.id}.`,
          unit: unit.id,
        });
      }
      seenUnitIds.add(unit.id);
      if (unit.source?.ref?.start && unit.source.ref.start < lastStart) {
        errors.push({
          code: "source-order",
          message: `${page.page} ${unit.id} appears out of source order.`,
          unit: unit.id,
        });
      }
      lastStart = unit.source?.ref?.start || lastStart;
      if (!ACTIONS.has(unit.action || "")) {
        errors.push({
          code: "unit-action",
          message: `${unit.id} has invalid action "${unit.action}".`,
          unit: unit.id,
        });
      }
      if (!REASONS.has(unit.reason || "")) {
        errors.push({
          code: "unit-reason",
          message: `${unit.id} has invalid reason "${unit.reason}".`,
          unit: unit.id,
        });
      }
      if (!STATUSES.has(unit.status || "")) {
        errors.push({
          code: "unit-status",
          message: `${unit.id} has invalid status "${unit.status}".`,
          unit: unit.id,
        });
      }
      if (
        unit.source?.ref &&
        options.cwd &&
        !sourceRangeExists(unit.source.ref, sourceArchive, options.cwd, sourceCache)
      ) {
        errors.push({
          code: "source-range",
          message: `${unit.id} source range does not exist: ${formatRef(unit.source.ref)}.`,
          unit: unit.id,
        });
      }
      for (const destination of unit.destinations || []) {
        if (
          destination.changedSinceSource !== undefined &&
          typeof destination.changedSinceSource !== "boolean"
        ) {
          errors.push({
            code: "destination-changed-since-source",
            message: `${unit.id} destination changedSinceSource must be boolean.`,
            unit: unit.id,
          });
        }
        if (destination.ref && options.cwd && !currentRangeExists(destination.ref, options.cwd)) {
          errors.push({
            code: "destination-range",
            message: `${unit.id} destination range does not exist: ${formatRef(destination.ref)}.`,
            unit: unit.id,
          });
        }
        if (
          destination.generator &&
          options.cwd &&
          !currentRangeExists(destination.generator, options.cwd)
        ) {
          errors.push({
            code: "generator-range",
            message: `${unit.id} generator range does not exist: ${formatRef(destination.generator)}.`,
            unit: unit.id,
          });
        }
      }
      if (data.schemaVersion >= 2) {
        const checked = validateSourceLineMappings(unit, {
          changedIndex,
          cwd: options.cwd,
          currentCache,
          errors,
          sourceArchive,
          warnings,
        });
        if (scope) {
          if (checked) scope.checkedUnits += 1;
          else scope.skippedUnits += 1;
        }
      }
    }
  }
  return { errors, scope, warnings };
}

function validateSourceLineMappings(unit, context) {
  if (context.changedIndex && !unitAffectedByChangedIndex(unit, context.changedIndex)) {
    return false;
  }
  const destinationRefs = new Set(
    (unit.destinations || []).map((destination) => formatRef(destination.ref)).filter(Boolean),
  );
  const lineTargetRefs = [];
  for (const line of unit.source?.lines || []) {
    const lineLabel = `${unit.id}:${line.number}`;
    if (!ACTIONS.has(line.action || "")) {
      context.errors.push({
        code: "line-action",
        line: line.number,
        message: `${lineLabel} has invalid action "${line.action}".`,
        unit: unit.id,
      });
    }
    if (!REASONS.has(line.reason || "")) {
      context.errors.push({
        code: "line-reason",
        line: line.number,
        message: `${lineLabel} has invalid reason "${line.reason}".`,
        unit: unit.id,
      });
    }
    if (!STATUSES.has(line.status || "")) {
      context.errors.push({
        code: "line-status",
        line: line.number,
        message: `${lineLabel} has invalid status "${line.status}".`,
        unit: unit.id,
      });
    }
    if (!Array.isArray(line.targets)) {
      context.errors.push({
        code: "line-targets",
        line: line.number,
        message: `${lineLabel} must have a targets array.`,
        unit: unit.id,
      });
      continue;
    }
    const material = !isFormattingOnlyLine(line.text);
    const intentionallyRemoved =
      line.status === "intentionally-removed" || line.action === "removed";
    if (
      ["covered", "partially-covered"].includes(line.status) &&
      material &&
      !line.targets.length
    ) {
      context.errors.push({
        code: "line-covered-without-target",
        line: line.number,
        message: `${lineLabel} is ${line.status} but has no target range.`,
        unit: unit.id,
      });
    }
    if (
      line.action === "removed" &&
      REMOVED_REASONS_REQUIRING_TARGETS.has(line.reason) &&
      !line.targets.length
    ) {
      context.errors.push({
        code: "removed-line-without-survivor",
        line: line.number,
        message: `${lineLabel} uses removed/${line.reason} but has no surviving target.`,
        unit: unit.id,
      });
    }
    if (line.status === "missing" && !line.notes) {
      context.errors.push({
        code: "missing-line-without-notes",
        line: line.number,
        message: `${lineLabel} is missing but has no notes.`,
        unit: unit.id,
      });
    }
    for (const target of line.targets) {
      if (target.note !== undefined || target.notes !== undefined) {
        context.errors.push({
          code: "line-target-legacy-notes",
          line: line.number,
          message: `${lineLabel} target uses legacy note/notes; use justification instead.`,
          unit: unit.id,
        });
      }
      if (!String(target.justification || "").trim()) {
        context.errors.push({
          code: "line-target-justification",
          line: line.number,
          message: `${lineLabel} target is missing required justification.`,
          unit: unit.id,
        });
      }
      if (target.changedSinceSource !== undefined) {
        context.errors.push({
          code: "line-target-changed-since-source",
          line: line.number,
          message: `${lineLabel} has target-level changedSinceSource; use destination-level metadata.`,
          unit: unit.id,
        });
      }
      if (target.ref) {
        lineTargetRefs.push(target.ref);
        if (context.cwd && !currentRangeExists(target.ref, context.cwd)) {
          context.errors.push({
            code: "line-target-range",
            line: line.number,
            message: `${lineLabel} target range does not exist: ${formatRef(target.ref)}.`,
            unit: unit.id,
          });
        }
      }
    }
    if (
      material &&
      line.status === "covered" &&
      line.targets.length &&
      line.targets.every((target) => target.mapping === "block-fallback")
    ) {
      const warning = {
        code: isStrongFactLine(line.text)
          ? "strong-fact-only-block-fallback"
          : "covered-line-only-block-fallback",
        line: line.number,
        message: `${lineLabel} is covered but only has broad block-fallback targets; confirm exact claim coverage or mark the line partial/missing.`,
        source: line.text,
        targets: line.targets.map((target) => formatRef(target.ref)).filter(Boolean),
        unit: unit.id,
      };
      context.warnings.push(warning);
    }
    if (material && line.targets.length && !intentionallyRemoved && context.cwd) {
      const affectedTargets = context.changedIndex
        ? line.targets.filter((target) =>
            refAffectedByChangedIndex(target.ref, context.changedIndex),
          )
        : line.targets;
      if (!affectedTargets.length) continue;
      const score = tokenOverlapScore(line.text, lineTargetText(affectedTargets, context.cwd));
      if (score < 0.2) {
        const stale = staleDestinationRangeFinding(unit, line, affectedTargets, score, context);
        if (stale) {
          context.errors.push(stale);
        } else {
          context.warnings.push({
            code: "low-line-target-overlap",
            line: line.number,
            message: `${lineLabel} has low text overlap with its target ranges; confirm this is not an over-broad mapping.`,
            score: Number(score.toFixed(2)),
            source: line.text,
            targets: affectedTargets.map((target) => formatRef(target.ref)).filter(Boolean),
            unit: unit.id,
          });
        }
      }
    }
  }
  for (const ref of destinationRefs) {
    const destinationRef = parseRef(ref);
    if (!lineTargetRefs.some((lineTargetRef) => refContains(destinationRef, lineTargetRef))) {
      context.warnings.push({
        code: "destination-not-line-targeted",
        message: `${unit.id} block destination ${ref} is not referenced by any source line target.`,
        unit: unit.id,
      });
    }
  }
  return true;
}

function staleDestinationRangeFinding(unit, line, targets, score, context) {
  if (!context.changedIndex) return null;
  const sourcePath = unit.source?.ref?.path || unit.page;
  const canEscalate =
    ["retained", "paraphrase"].includes(line.action || unit.action) &&
    (line.reason || unit.reason) === "same-scope";
  if (!canEscalate) return null;
  for (const target of targets) {
    if (!target.ref || target.ref.path !== sourcePath) continue;
    const suggestion = bestLineMatch(line.text, target.ref.path, context.cwd, context.currentCache);
    if (!suggestion || refContains(target.ref, suggestion.ref)) continue;
    return {
      code: "stale-destination-range",
      currentTarget: formatRef(target.ref),
      line: line.number,
      message: `${unit.id}:${line.number} appears to point at a stale destination range. Current target ${formatRef(target.ref)} has low overlap; suggested target is ${formatRef(suggestion.ref)}.`,
      score: Number(score.toFixed(2)),
      source: line.text,
      suggestedTarget: formatRef(suggestion.ref),
      suggestedText: suggestion.text,
      unit: unit.id,
    };
  }
  return null;
}

function formatRef(ref) {
  if (!ref) return "";
  return `${ref.path}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ""}`;
}

function refContains(container, contained) {
  if (!container || !contained) return false;
  return (
    container.path === contained.path &&
    Number(container.start) <= Number(contained.start) &&
    Number(container.end || container.start) >= Number(contained.end || contained.start)
  );
}

function renderHtml(data, templatePath) {
  const template = fs.readFileSync(templatePath, "utf8");
  const embedded = JSON.stringify(data).replace(/</g, "\\u003c");
  if (!template.includes("__AUDIT_DATA__")) {
    throw new Error(`Template missing __AUDIT_DATA__ placeholder: ${templatePath}`);
  }
  return template.replace("__AUDIT_DATA__", embedded);
}

function renderDetailedMarkdown(data) {
  const firstPage = data.pages[0];
  const sourceArchive = sourceArchiveForData(data);
  const sourceRef =
    sourceArchive.ref || [sourceArchive.gitRef, sourceArchive.path].filter(Boolean).join(":");
  const lines = [
    "---",
    `title: ${data.title}`,
    data.frontmatter?.spec ? `spec: ${data.frontmatter.spec}` : null,
    data.frontmatter?.schema ? `schema: ${data.frontmatter.schema}` : "schema: ag-dir-v2",
    data.frontmatter?.status ? `status: ${data.frontmatter.status}` : "status: complete",
    data.frontmatter?.last_refreshed ? `last_refreshed: ${data.frontmatter.last_refreshed}` : null,
    data.frontmatter?.last_refreshed_by
      ? `last_refreshed_by: ${data.frontmatter.last_refreshed_by}`
      : null,
    sourceRef ? `source_ref: ${sourceRef}` : null,
    "report_kind: detailed-checklist",
    "---",
    "",
    `# ${data.title}`,
    "",
    sourceRef ? "`<SOURCE_REF_OR_ARCHIVE>` is `" + sourceRef + "`." : null,
    "",
  ].filter((line) => line !== null);

  for (const page of data.pages) {
    lines.push(`## ${page.page}`, "");
    lines.push("| Source page | Coverage |");
    lines.push("| --- | --- |");
    lines.push(`| \`${page.page}\` | ${markdownCell(page.coverage)} |`);
    lines.push("");
    lines.push("| ID | Source | Summary | Action | Reason | Destination | Status | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const unit of page.units) {
      const markdown = unit.markdown || {};
      lines.push(
        [
          markdown.id || `${unit.id}: ${unit.label}`,
          markdown.source || sourceMarkdown(unit),
          markdown.summary || markdownCell(unit.summary),
          markdown.action || markdownCell(unit.action),
          markdown.reason || markdownCell(unit.reason),
          markdown.destination || destinationsMarkdown(unit.destinations),
          markdown.status || markdownCell(unit.status),
          markdown.notes || markdownCell(unit.notes),
        ]
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }
    const counters = page.counters || {
      auditedUnits: page.units.length,
      gaps: "none",
      sourceUnits: page.units.length,
    };
    lines.push("");
    lines.push(
      `source_units=${counters.sourceUnits} audited_units=${counters.auditedUnits} gaps=${counters.gaps}`,
    );
    lines.push("");
  }

  if (data.validation?.errors?.length || data.validation?.warnings?.length) {
    lines.push("## Line-Level Validation Notes", "");
    if (data.validation.errors?.length) {
      lines.push("### Errors", "");
      for (const error of data.validation.errors) {
        lines.push(`- ${markdownCell(error.message || JSON.stringify(error))}`);
      }
      lines.push("");
    }
    if (data.validation.warnings?.length) {
      lines.push("### Warnings", "");
      for (const warning of data.validation.warnings) {
        const source = warning.source ? ` Source: ${warning.source}` : "";
        const targets = warning.targets?.length ? ` Targets: ${warning.targets.join(", ")}` : "";
        const score =
          typeof warning.score === "number" ? ` Score: ${warning.score.toFixed(2)}.` : "";
        lines.push(
          `- ${markdownCell(warning.message || JSON.stringify(warning))}${score}${source}${targets}`,
        );
      }
      lines.push("");
    }
  }

  if (firstPage)
    lines.push(`Generated from JSON with ${data.generator?.script || "audit-report-viewer.mjs"}.`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function markdownCell(value) {
  return String(value || "")
    .replace(/\n/g, "<br />")
    .replace(/\|/g, "\\|");
}

function sourceMarkdown(unit) {
  const ref = unit.source?.ref;
  if (!ref) return "";
  return `\`${ref.path}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ""}\` from \`<SOURCE_REF_OR_ARCHIVE>\``;
}

function destinationsMarkdown(destinations) {
  return (destinations || [])
    .map((dest) => {
      if (!dest.ref)
        return markdownCell(dest.note || dest.notes || "external source; no repo line");
      const ref = `\`${dest.ref.path}:${dest.ref.start}${dest.ref.end !== dest.ref.start ? `-${dest.ref.end}` : ""}\``;
      if (!dest.generator) return ref;
      return `${ref} (generated by \`${dest.generator.path}:${dest.generator.start}${dest.generator.end !== dest.generator.start ? `-${dest.generator.end}` : ""}\`)`;
    })
    .join("<br />");
}

function defaultBasename(reportPath) {
  return path
    .basename(reportPath, path.extname(reportPath))
    .replace(/-paragraph-rewrite-audit$/, "")
    .replace(/-rewrite-audit$/, "")
    .replace(/-detailed$/, "");
}

function outputPaths(args, cwd, reportPath) {
  const basename = args.basename || (reportPath ? defaultBasename(reportPath) : "docs-audit");
  const outDir = resolveFrom(cwd, args["out-dir"]);
  return {
    detailedOut: resolveFrom(cwd, args["detailed-out"]),
    htmlOut:
      resolveFrom(cwd, args["html-out"]) ||
      (outDir ? path.join(outDir, `${basename}-audit-viewer.html`) : undefined),
    jsonOut:
      resolveFrom(cwd, args["json-out"]) ||
      (outDir && !args.data ? path.join(outDir, `${basename}-audit-data.json`) : undefined),
  };
}

function validateData(data, options = {}) {
  const validation = collectValidation(data, options);
  if (validation.errors.length) {
    throw new Error(
      `Audit data validation failed:\n${validation.errors
        .map((error) => `- ${error.message}`)
        .join("\n")}`,
    );
  }
  return validation;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function writeText(filePath, text) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, text);
}

function printSummary(data, written, validation = data.validation) {
  const units = data.pages.flatMap((page) => page.units || []);
  console.log(
    JSON.stringify(
      {
        pages: data.pages.length,
        schemaVersion: data.schemaVersion,
        units: units.length,
        validation: validation
          ? {
              errors: validation.errors?.length || 0,
              warnings: validation.warnings?.length || 0,
            }
          : undefined,
        written,
      },
      null,
      2,
    ),
  );
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "legacy";
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const cwd = resolveFrom(process.cwd(), args.cwd) || process.cwd();
  const reportPath = resolveFrom(cwd, args.report);
  const dataPath = resolveFrom(cwd, args.data);
  const templatePath = resolveFrom(cwd, args.template) || defaultTemplatePath;

  if (command === "scaffold") {
    const jsonOut = resolveFrom(cwd, args["json-out"]);
    if (!jsonOut) throw new Error("scaffold requires --json-out.");
    const data = scaffoldV2({
      cwd,
      id: args.id,
      sourcePages: args["source-pages"],
      sourceRef: args["source-ref"],
      spec: args.spec,
      title: args.title,
    });
    writeJson(jsonOut, data);
    printSummary(data, { json: jsonOut });
    return;
  }

  if (command === "migrate-v1") {
    if (!reportPath) throw new Error("migrate-v1 requires --report.");
    const jsonOut = resolveFrom(cwd, args["json-out"]);
    if (!jsonOut) throw new Error("migrate-v1 requires --json-out.");
    const legacyData = parseDetailedReport(reportPath, {
      changedPages: args["changed-pages"],
      cwd,
      sourceRef: args["source-ref"],
      title: args.title,
    });
    validateData(legacyData, { cwd });
    const data = migrateV1ToV3(legacyData);
    data.validation = collectValidation(data, { cwd });
    writeJson(jsonOut, data);
    printSummary(data, { json: jsonOut }, data.validation);
    return;
  }

  if (command === "validate") {
    if (!dataPath) throw new Error("validate requires --data.");
    const data = readJson(dataPath);
    const validation = collectValidation(data, {
      changedOnly: Boolean(args["changed-only"]),
      cwd,
      diffBase: args["diff-base"],
    });
    console.log(JSON.stringify(validation, null, 2));
    if (validation.errors.length) process.exitCode = 1;
    return;
  }

  if (command === "hydrate") {
    if (!dataPath) throw new Error("hydrate requires --data.");
    const jsonOut = resolveFrom(cwd, args["json-out"]);
    if (!jsonOut) throw new Error("hydrate requires --json-out.");
    const data = hydrateV2(readJson(dataPath), {
      changedPages: args["changed-pages"],
      cwd,
    });
    validateData(data, { cwd });
    writeJson(jsonOut, data);
    printSummary(data, { json: jsonOut }, data.validation);
    return;
  }

  if (command === "render") {
    if (!dataPath) throw new Error("render requires --data.");
    const data = readJson(dataPath);
    if (args["changed-pages"]) {
      data.changedPages = parseChangedPages(args["changed-pages"]);
      data.pageViews = buildPageViews(data.pages, data.changedPages);
    }
    const validation = validateData(data, { cwd });
    const htmlOut = resolveFrom(cwd, args["html-out"]);
    const detailedOut = resolveFrom(cwd, args["detailed-out"]);
    if (!htmlOut && !detailedOut) throw new Error("render requires --html-out or --detailed-out.");
    const written = {};
    if (htmlOut) {
      writeText(htmlOut, renderHtml(data, templatePath));
      written.html = htmlOut;
    }
    if (detailedOut) {
      writeText(detailedOut, renderDetailedMarkdown(data));
      written.detailed = detailedOut;
    }
    printSummary(data, written, validation);
    return;
  }

  if (command !== "legacy") {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }

  if (!reportPath && !dataPath) {
    usage();
    throw new Error("Pass --report or --data.");
  }
  const paths = outputPaths(args, cwd, reportPath);
  let data;
  if (dataPath) {
    data = readJson(dataPath);
    if (args["changed-pages"]) {
      data.changedPages = parseChangedPages(args["changed-pages"]);
      data.pageViews = buildPageViews(data.pages, data.changedPages);
    }
  } else {
    data = parseDetailedReport(reportPath, {
      changedPages: args["changed-pages"],
      cwd,
      sourceRef: args["source-ref"],
      title: args.title,
    });
  }
  const validation = validateData(data, { cwd });

  const written = {};
  if (paths.jsonOut) {
    writeJson(paths.jsonOut, data);
    written.json = paths.jsonOut;
  }
  if (paths.htmlOut) {
    writeText(paths.htmlOut, renderHtml(data, templatePath));
    written.html = paths.htmlOut;
  }
  if (paths.detailedOut) {
    writeText(paths.detailedOut, renderDetailedMarkdown(data));
    written.detailed = paths.detailedOut;
  }

  printSummary(data, written, validation);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
