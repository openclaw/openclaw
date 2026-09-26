/**
 * `openclaw path` — shell access to the OcPath substrate verbs.
 *
 * Subcommands: `resolve` / `set` / `find` / `validate` / `emit`.
 * TTY-aware output: human when interactive, JSON when piped; `--json`
 * / `--human` override.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import {
  MAX_JSONC_INPUT_BYTES,
  OcEmitSentinelError,
  OcPathError,
  REDACTED_SENTINEL,
  emitJsonc,
  emitJsonl,
  emitMd,
  emitYaml,
  findOcPaths,
  formatOcPath,
  inferKind,
  parseJsonc,
  parseJsonl,
  parseMd,
  parseOcPath,
  parseYaml,
  resolveOcPath,
  setOcPath,
  type OcAst,
  type OcMatch,
  type OcPath,
} from "./oc-path/index.js";

interface PathCommandOptions {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly valueJson?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

type OutputMode = "human" | "json";

// Keep every parser behind the shipped JSONC ceiling so user-selected files
// cannot allocate an unbounded input before format-specific validation runs.
const MAX_OC_PATH_INPUT_BYTES = MAX_JSONC_INPUT_BYTES;

type LoadedOcPathFile = {
  readonly ast: OcAst;
  readonly raw: string;
};

const SCRUB_PLACEHOLDER = "[REDACTED]";

// Defense-in-depth: replace the redaction sentinel with `[REDACTED]`
// before writing, even if upstream emits it.
function scrubSentinel(s: string): string {
  if (!s.includes(REDACTED_SENTINEL)) {
    return s;
  }
  return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}

function detectMode(options: PathCommandOptions): OutputMode {
  if (options.json === true) {
    return "json";
  }
  if (options.human === true) {
    return "human";
  }
  return process.stdout.isTTY ? "human" : "json";
}

function emit(mode: OutputMode, value: unknown, humanFallback: () => string): void {
  if (mode === "json") {
    process.stdout.write(scrubSentinel(JSON.stringify(value, null, 2)));
    return;
  }
  process.stdout.write(scrubSentinel(humanFallback()));
}

function emitError(mode: OutputMode, message: string, code = "ERR"): void {
  const scrubbed = scrubSentinel(message);
  if (mode === "json") {
    process.stderr.write(`${JSON.stringify({ error: { code, message: scrubbed } })}\n`);
    return;
  }
  process.stderr.write(`${code}: ${scrubbed}\n`);
}

/** Parse an oc-path string; emit structured error and return null on failure. */
function tryParse(pathStr: string, mode: OutputMode): OcPath | null {
  try {
    return parseOcPath(pathStr);
  } catch (err) {
    if (err instanceof OcPathError) {
      emitError(mode, `parse failed: ${err.message}`, err.code);
      process.exitCode = 2;
      return null;
    }
    throw err;
  }
}

// Catch OcEmitSentinelError so it goes through the structured error
// path; otherwise commander prints `String(err)` raw and bypasses the
// `--json` scrubbed-error boundary.
function catchSentinel<T>(label: string, mode: OutputMode, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof OcEmitSentinelError) {
      emitError(mode, `${label} refused: ${err.message}`, "OC_EMIT_SENTINEL");
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
}

async function loadOcPathFile(
  absPath: string,
  fileName: string,
  mode: OutputMode,
): Promise<LoadedOcPathFile | null> {
  const kind = inferKind(fileName);
  // A blocking open can hang on a FIFO before stat can reject it. O_NONBLOCK
  // preserves regular-file and symlink reads while making that check reachable.
  const handle = await fs.open(absPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      emitError(mode, `not a regular file: ${absPath}`, "OC_PATH_FILE_NOT_REGULAR");
      process.exitCode = 2;
      return null;
    }
    // `end` is inclusive, so a raced growth can return at most the cap plus one byte.
    const bytes =
      stat.size > MAX_OC_PATH_INPUT_BYTES
        ? null
        : Buffer.concat(
            await handle
              .createReadStream({ autoClose: false, end: MAX_OC_PATH_INPUT_BYTES, start: 0 })
              .toArray(),
          );
    if (bytes === null || bytes.length > MAX_OC_PATH_INPUT_BYTES) {
      emitError(
        mode,
        `input exceeds ${MAX_OC_PATH_INPUT_BYTES} bytes${stat.size > MAX_OC_PATH_INPUT_BYTES ? `; got ${stat.size}` : ""}`,
        kind === "jsonc" ? "OC_JSONC_INPUT_TOO_LARGE" : "OC_PATH_INPUT_TOO_LARGE",
      );
      process.exitCode = 2;
      return null;
    }
    raw = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  if (kind === "jsonc") {
    const result = parseJsonc(raw);
    const sizeDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "OC_JSONC_INPUT_TOO_LARGE",
    );
    if (sizeDiagnostic) {
      emitError(mode, sizeDiagnostic.message, sizeDiagnostic.code);
      process.exitCode = 2;
      return null;
    }
    return { ast: result.ast, raw };
  }
  if (kind === "jsonl") {
    return { ast: parseJsonl(raw).ast, raw };
  }
  if (kind === "yaml") {
    return { ast: parseYaml(raw).ast, raw };
  }
  return { ast: parseMd(raw).ast, raw };
}

function emitForKind(ast: OcAst, fileName?: string): string {
  // Plumb fileName so sentinel errors carry file context.
  const opts = fileName !== undefined ? { fileNameForGuard: fileName } : {};
  switch (ast.kind) {
    case "jsonc":
      return emitJsonc(ast, opts);
    case "jsonl":
      return emitJsonl(ast, opts);
    case "md":
      return emitMd(ast, opts);
    case "yaml":
      return emitYaml(ast, opts);
  }
  return "";
}

function resolveFsPath(path: OcPath, options: PathCommandOptions): string {
  if (options.file !== undefined) {
    return resolvePath(options.file);
  }
  return resolvePath(options.cwd ?? process.cwd(), path.file);
}

function formatMatchHuman(match: OcMatch): string {
  if (match.kind === "leaf") {
    return `leaf @ L${match.line}: ${JSON.stringify(match.valueText)} (${match.leafType})`;
  }
  if (match.kind === "node") {
    return `node @ L${match.line} [${match.descriptor}]`;
  }
  if (match.kind === "insertion-point") {
    return `insertion-point @ L${match.line} [${match.container}]`;
  }
  return `root @ L${match.line}`;
}

function formatUnifiedDiff(oldBytes: string, newBytes: string, fsPath: string): string {
  if (oldBytes === newBytes) {
    return "";
  }
  const oldLines = oldBytes.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = newBytes.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0;
  while (start < oldLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const contextStart = Math.max(0, start - 3);
  const trailing = Math.min(3, oldLines.length - oldEnd);

  // Empty-side patches preserve newline markers without a quadratic search
  // when a Markdown edit normalizes every CRLF line in a large file.
  const formatLines = (prefix: string, lines: string[]) =>
    (structuredPatch("", "", "", lines.join("")).hunks[0]?.lines ?? []).map((line) =>
      line.startsWith("+") ? `${prefix}${line.slice(1)}` : line,
    );
  const patch = structuredPatch(fsPath, fsPath, "", "");
  patch.hunks.push({
    oldStart: contextStart + 1,
    oldLines: oldEnd - contextStart + trailing,
    newStart: contextStart + 1,
    newLines: newEnd - contextStart + trailing,
    lines: [
      ...formatLines(" ", oldLines.slice(contextStart, start)),
      ...formatLines("-", oldLines.slice(start, oldEnd)),
      ...formatLines("+", newLines.slice(start, newEnd)),
      ...formatLines(" ", oldLines.slice(oldEnd, oldEnd + trailing)),
    ],
  });
  return formatPatch(patch, FILE_HEADERS_ONLY);
}

// ---------- Commands -----------------------------------------------------

async function pathResolveCommand(pathStr: string, options: PathCommandOptions): Promise<void> {
  const mode = detectMode(options);
  const ocPath = tryParse(pathStr, mode);
  if (ocPath === null) {
    return;
  }
  const loaded = await loadOcPathFile(resolveFsPath(ocPath, options), ocPath.file, mode);
  if (loaded === null) {
    return;
  }
  let match: OcMatch | null;
  try {
    match = resolveOcPath(loaded.ast, ocPath);
  } catch (err) {
    if (err instanceof OcPathError) {
      // resolveOcPath throws on wildcard patterns — point at find.
      emitError(mode, `resolve refused: ${err.message}`, err.code);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  if (match === null) {
    emit(mode, { resolved: false, ocPath: pathStr }, () => `not found: ${pathStr}`);
    process.exitCode = 1;
    return;
  }
  emit(mode, { resolved: true, ocPath: pathStr, match }, () => formatMatchHuman(match));
}

async function pathSetCommand(
  pathStr: string,
  value: string,
  options: PathCommandOptions,
): Promise<void> {
  const mode = detectMode(options);
  if (options.diff === true && options.dryRun !== true) {
    emit(
      mode,
      { ok: false, reason: "--diff requires --dry-run" },
      () => "set failed: --diff requires --dry-run",
    );
    process.exitCode = 1;
    return;
  }
  const ocPath = tryParse(pathStr, mode);
  if (ocPath === null) {
    return;
  }
  const fsPath = resolveFsPath(ocPath, options);
  const loaded = await loadOcPathFile(fsPath, ocPath.file, mode);
  if (loaded === null) {
    return;
  }

  const result = catchSentinel("set", mode, () =>
    setOcPath(loaded.ast, ocPath, value, { valueJson: options.valueJson === true }),
  );
  if (result === null) {
    return;
  }
  if (!result.ok) {
    const detail = result.detail;
    emit(
      mode,
      { ok: false, reason: result.reason, detail },
      () => `set failed: ${result.reason}${detail !== undefined ? ` — ${detail}` : ""}`,
    );
    process.exitCode = 1;
    return;
  }
  // Per-kind emit can still refuse the sentinel even after set succeeds.
  const newBytes = catchSentinel("emit", mode, () => emitForKind(result.ast, ocPath.file));
  if (newBytes === null) {
    return;
  }

  const byteLength = Buffer.byteLength(newBytes, "utf8");

  if (options.dryRun === true) {
    const diff =
      options.diff === true ? formatUnifiedDiff(loaded.raw, newBytes, fsPath) : undefined;
    emit(
      mode,
      { ok: true, dryRun: true, bytes: newBytes, ...(diff !== undefined ? { diff } : {}) },
      () =>
        diff !== undefined
          ? diff || `--dry-run: no byte changes for ${fsPath}`
          : `--dry-run: would write ${byteLength} bytes to ${fsPath}\n${newBytes}`,
    );
    return;
  }
  await fs.writeFile(fsPath, newBytes, "utf-8");
  emit(
    mode,
    { ok: true, dryRun: false, bytesWritten: byteLength, fsPath },
    () => `wrote ${byteLength} bytes to ${fsPath}`,
  );
}

async function pathFindCommand(patternStr: string, options: PathCommandOptions): Promise<void> {
  const mode = detectMode(options);
  const pattern = tryParse(patternStr, mode);
  if (pattern === null) {
    return;
  }
  // File-slot wildcards would silently ENOENT during readFile; reject.
  if (/[*?]/.test(pattern.file)) {
    emitError(
      mode,
      `find: file-slot wildcards are not supported (got "${pattern.file}"). ` +
        `Pass a concrete file path; multi-file globbing is a follow-up feature.`,
      "OC_PATH_FILE_WILDCARD_UNSUPPORTED",
    );
    process.exitCode = 2;
    return;
  }
  const loaded = await loadOcPathFile(resolveFsPath(pattern, options), pattern.file, mode);
  if (loaded === null) {
    return;
  }
  const matches = findOcPaths(loaded.ast, pattern);
  emit(
    mode,
    {
      pattern: patternStr,
      count: matches.length,
      matches: matches.map((m) => ({ path: formatOcPath(m.path), match: m.match })),
    },
    () => {
      if (matches.length === 0) {
        return `0 matches for ${patternStr}`;
      }
      const plural = matches.length === 1 ? "" : "es";
      const lines = [`${matches.length} match${plural} for ${patternStr}:`];
      for (const m of matches) {
        lines.push(`  ${formatOcPath(m.path)}  →  ${formatMatchHuman(m.match)}`);
      }
      return lines.join("\n");
    },
  );
  if (matches.length === 0) {
    process.exitCode = 1;
  }
}

function pathValidateCommand(pathStr: string, options: PathCommandOptions): void {
  const mode = detectMode(options);
  try {
    const ocPath = parseOcPath(pathStr);
    emit(
      mode,
      {
        valid: true,
        ocPath: pathStr,
        formatted: formatOcPath(ocPath),
        structure: {
          file: ocPath.file,
          section: ocPath.section,
          item: ocPath.item,
          field: ocPath.field,
          session: ocPath.session,
        },
      },
      () => {
        const lines = [`valid: ${pathStr}`, `  file:    ${ocPath.file}`];
        if (ocPath.section !== undefined) {
          lines.push(`  section: ${ocPath.section}`);
        }
        if (ocPath.item !== undefined) {
          lines.push(`  item:    ${ocPath.item}`);
        }
        if (ocPath.field !== undefined) {
          lines.push(`  field:   ${ocPath.field}`);
        }
        if (ocPath.session !== undefined) {
          lines.push(`  session: ${ocPath.session}`);
        }
        return lines.join("\n");
      },
    );
  } catch (err) {
    if (err instanceof OcPathError) {
      emit(
        mode,
        { valid: false, code: err.code, message: err.message },
        () => `INVALID: ${err.code}: ${err.message}`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function pathEmitCommand(fileArg: string, options: PathCommandOptions): Promise<void> {
  const mode = detectMode(options);
  const fsPath =
    options.file !== undefined
      ? resolvePath(options.file)
      : resolvePath(options.cwd ?? process.cwd(), fileArg);
  const fileName = fsPath.split(/[\\/]/).pop() ?? fileArg;
  const loaded = await loadOcPathFile(fsPath, fileName, mode);
  if (loaded === null) {
    return;
  }
  const bytes = catchSentinel("emit", mode, () => emitForKind(loaded.ast, fileName));
  if (bytes === null) {
    return;
  }
  if (mode === "json") {
    process.stdout.write(scrubSentinel(JSON.stringify({ ok: true, kind: loaded.ast.kind, bytes })));
    return;
  }
  process.stdout.write(bytes);
}

// ---------- Commander wiring ---------------------------------------------

function withCommonOpts(cmd: Command): Command {
  return cmd
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .option("--cwd <dir>", "Resolve file slot against this directory")
    .option("--file <file>", "Override the file slot's resolved path");
}

export function registerPathCli(program: Command): void {
  const path = program
    .command("path")
    .description("Inspect and edit workspace files via the oc:// addressing scheme")
    .addHelpText("after", "\nDocs: https://docs.openclaw.ai/cli/path\n");

  withCommonOpts(
    path
      .command("resolve")
      .description("Print the match at an oc:// path")
      .argument("<oc-path>", "oc:// path to resolve"),
  ).action(async (pathStr: string, opts: PathCommandOptions) => {
    await pathResolveCommand(pathStr, opts);
  });

  withCommonOpts(
    path
      .command("find")
      .description("Enumerate matches for a wildcard / predicate oc:// pattern")
      .argument("<pattern>", "oc:// pattern"),
  ).action(async (patternStr: string, opts: PathCommandOptions) => {
    await pathFindCommand(patternStr, opts);
  });

  withCommonOpts(
    path
      .command("set")
      .description("Write a leaf value at an oc:// path")
      .argument("<oc-path>", "oc:// path to write")
      .argument("<value>", "string value to write")
      .option("--value-json", "Parse <value> as JSON for JSON/JSONC/JSONL leaf replacement")
      .option("--dry-run", "Print bytes without writing")
      .option("--diff", "With --dry-run, print a unified diff instead of full bytes"),
  ).action(async (pathStr: string, value: string, opts: PathCommandOptions) => {
    await pathSetCommand(pathStr, value, opts);
  });

  path
    .command("validate")
    .description("Parse an oc:// path and print its slot structure")
    .argument("<oc-path>", "oc:// path to validate")
    .option("--json", "Force JSON output")
    .option("--human", "Force human output")
    .action((pathStr: string, opts: PathCommandOptions) => {
      pathValidateCommand(pathStr, opts);
    });

  withCommonOpts(
    path
      .command("emit")
      .description("Round-trip a file through parse + emit")
      .argument("<file>", "Path to a workspace file"),
  ).action(async (fileArg: string, opts: PathCommandOptions) => {
    await pathEmitCommand(fileArg, opts);
  });

  // Bare `openclaw path` prints help and exits 0 (matches the core
  // applyParentDefaultHelpAction contract — see openclaw#73077).
  path.action(() => {
    path.outputHelp();
    process.exitCode = 0;
  });
}
