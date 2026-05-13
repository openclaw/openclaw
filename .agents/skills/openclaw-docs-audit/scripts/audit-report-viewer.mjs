#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const defaultTemplatePath = path.join(skillDir, "assets", "audit-viewer.html");

function usage() {
  console.error(`Usage:
  audit-report-viewer.mjs --report <detailed-report.md> --out-dir <dir> [--basename <name>] [--source-ref <git-ref[:path]>]
  audit-report-viewer.mjs --data <audit-data.json> --html-out <viewer.html> [--detailed-out <detailed.md>]

Options:
  --report <path>       Detailed audit markdown table to convert into JSON.
  --data <path>         Existing audit JSON to render.
  --out-dir <dir>       Directory for <basename>-audit-data.json and <basename>-audit-viewer.html.
  --basename <name>     Output basename. Defaults from --report.
  --json-out <path>     Explicit JSON output path.
  --html-out <path>     Explicit HTML output path.
  --detailed-out <path> Optional normalized detailed markdown output path.
  --source-ref <ref>    Source archive git ref or gitRef:path. Defaults from report frontmatter source_ref.
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

function getCurrentLines(ref, cwd) {
  if (!ref) return [];
  const filePath = path.join(cwd, ref.path);
  if (!fs.existsSync(filePath)) return [];
  return linesForRange(fs.readFileSync(filePath, "utf8").split(/\r?\n/), ref);
}

function linesForRange(lines, ref) {
  if (!lines || !lines.length || !ref) return [];
  return lines.slice(ref.start - 1, ref.end).map((text, index) => ({
    number: ref.start + index,
    text,
  }));
}

function parseDestinations(cell, cwd) {
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

function parseDetailedReport(reportPath, options) {
  const cwd = options.cwd;
  const text = fs.readFileSync(reportPath, "utf8");
  const { frontmatter } = parseFrontmatter(text);
  const sourceArchive = parseSourceArchive(options.sourceRef || frontmatter.source_ref);
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
        destinations: parseDestinations(cells[5], cwd),
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
  for (const page of pages) page.count = page.units.length;
  const title = options.title || frontmatter.title || "Docs Rewrite Audit";
  return {
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
    pages,
  };
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
  const sourceRef =
    data.sourceArchive.ref ||
    [data.sourceArchive.gitRef, data.sourceArchive.path].filter(Boolean).join(":");
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
      if (!dest.ref) return markdownCell(dest.note || "external source; no repo line");
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

function validateData(data) {
  const units = data.pages.flatMap((page) => page.units);
  if (data.schemaVersion !== 1) throw new Error("Expected schemaVersion 1.");
  if (!data.pages.length) throw new Error("Audit data has no pages.");
  if (!units.length) throw new Error("Audit data has no units.");
  const missingSource = units.filter((unit) => unit.source?.ref && !unit.source.lines?.length);
  if (missingSource.length) {
    throw new Error(`Missing source lines for ${missingSource.map((unit) => unit.id).join(", ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const cwd = resolveFrom(process.cwd(), args.cwd) || process.cwd();
  const reportPath = resolveFrom(cwd, args.report);
  const dataPath = resolveFrom(cwd, args.data);
  if (!reportPath && !dataPath) {
    usage();
    throw new Error("Pass --report or --data.");
  }
  const templatePath = resolveFrom(cwd, args.template) || defaultTemplatePath;
  const paths = outputPaths(args, cwd, reportPath);
  let data;
  if (dataPath) {
    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  } else {
    data = parseDetailedReport(reportPath, {
      cwd,
      sourceRef: args["source-ref"],
      title: args.title,
    });
  }
  validateData(data);

  const written = {};
  if (paths.jsonOut) {
    ensureParent(paths.jsonOut);
    fs.writeFileSync(paths.jsonOut, JSON.stringify(data, null, 2) + "\n");
    written.json = paths.jsonOut;
  }
  if (paths.htmlOut) {
    ensureParent(paths.htmlOut);
    fs.writeFileSync(paths.htmlOut, renderHtml(data, templatePath));
    written.html = paths.htmlOut;
  }
  if (paths.detailedOut) {
    ensureParent(paths.detailedOut);
    fs.writeFileSync(paths.detailedOut, renderDetailedMarkdown(data));
    written.detailed = paths.detailedOut;
  }

  const units = data.pages.flatMap((page) => page.units);
  console.log(
    JSON.stringify(
      {
        pages: data.pages.length,
        units: units.length,
        written,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
