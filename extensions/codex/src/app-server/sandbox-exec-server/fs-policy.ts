import { posix as pathPosix } from "node:path";
import type { JsonObject } from "../protocol.js";
import { requireObject, requireString } from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import type {
  FsAccessMode,
  OpenClawExecServer,
  ResolvedFsSandboxEntry,
  ResolvedFsSandboxPolicy,
} from "./types.js";

const FS_ACCESS_RANK = { read: 0, write: 1, none: 2 } satisfies Record<FsAccessMode, number>;

/** Parses a Codex managed filesystem sandbox context into normalized access entries. */
export function resolveFsSandboxPolicy(
  execServer: OpenClawExecServer,
  record: JsonObject,
): ResolvedFsSandboxPolicy | undefined {
  if (record.sandbox === undefined || record.sandbox === null) {
    return undefined;
  }
  const sandbox = requireObject(record.sandbox, "fs sandbox context");
  const permissions = requireObject(sandbox.permissions, "fs sandbox permissions");
  const permissionType = requireString(permissions.type, "fs sandbox permissions type");
  if (permissionType === "disabled" || permissionType === "external") {
    return { unrestricted: true, entries: [] };
  }
  if (permissionType !== "managed") {
    throw new Error(`Unsupported Codex fs sandbox permission type: ${permissionType}`);
  }

  const fileSystem = requireObject(permissions.file_system, "fs sandbox file system permissions");
  const fileSystemType = requireString(fileSystem.type, "fs sandbox file system permissions type");
  if (fileSystemType === "unrestricted") {
    return { unrestricted: true, entries: [] };
  }
  if (fileSystemType !== "restricted") {
    throw new Error(`Unsupported Codex fs sandbox file system type: ${fileSystemType}`);
  }
  if (!Array.isArray(fileSystem.entries)) {
    throw new Error("fs sandbox file system entries must be an array.");
  }
  const cwd = readFsSandboxCwd(execServer, sandbox);
  return {
    unrestricted: false,
    entries: fileSystem.entries.flatMap((entry, index) => {
      const resolved = resolveFsSandboxEntry(
        requireObject(entry, `fs sandbox entry ${index}`),
        cwd,
      );
      return resolved ? [resolved] : [];
    }),
  };
}

function readFsSandboxCwd(execServer: OpenClawExecServer, sandbox: JsonObject): string {
  if (sandbox.cwd === undefined || sandbox.cwd === null) {
    return normalizeSandboxAbsolutePath(execServer.sandbox.containerWorkdir, "sandbox cwd");
  }
  return normalizeSandboxAbsolutePath(
    resolveExecServerPath(requireString(sandbox.cwd, "sandbox cwd"), "sandbox cwd"),
    "sandbox cwd",
  );
}

function resolveFsSandboxEntry(entry: JsonObject, cwd: string): ResolvedFsSandboxEntry | undefined {
  const access = readFsAccessMode(entry.access);
  const pathSpec = requireObject(entry.path, "fs sandbox entry path");
  const pathType = requireString(pathSpec.type, "fs sandbox entry path type");
  if (pathType === "path" || pathType === "special") {
    const path =
      pathType === "path"
        ? normalizeSandboxAbsolutePath(
            resolveExecServerPath(
              requireString(pathSpec.path, "fs sandbox path"),
              "fs sandbox path",
            ),
            "fs sandbox path",
          )
        : resolveFsSpecialPath(requireObject(pathSpec.value, "fs sandbox special path"), cwd);
    return path === undefined ? undefined : { kind: "path", path, access };
  }
  if (pathType === "glob_pattern") {
    const pattern = requireString(pathSpec.pattern, "fs sandbox glob pattern");
    const absolutePattern = normalizeSandboxGlobPattern(
      pattern.startsWith("/") ? pattern : pathPosix.join(cwd, pattern),
    );
    return {
      kind: "glob",
      pattern: absolutePattern,
      matcher: compileSandboxGlobMatcher(absolutePattern),
      literalPrefix: sandboxGlobLiteralPrefix(absolutePattern),
      access,
    };
  }
  throw new Error(`Unsupported Codex fs sandbox path type: ${pathType}`);
}

function readFsAccessMode(value: unknown): FsAccessMode {
  if (value === "read" || value === "write" || value === "none") {
    return value;
  }
  if (value === "deny") {
    return "none";
  }
  throw new Error("fs sandbox entry access must be read, write, none, or deny.");
}

function resolveFsSpecialPath(value: JsonObject, cwd: string): string | undefined {
  const kind = requireString(value.kind, "fs sandbox special path kind");
  if (kind === "minimal" || kind === "unknown") {
    return undefined;
  }
  if (kind === "root") {
    return "/";
  }
  if (kind === "project_roots" || kind === "current_working_directory") {
    const subpath =
      value.subpath === undefined || value.subpath === null
        ? undefined
        : requireString(value.subpath, "fs sandbox project roots subpath");
    return normalizeSandboxAbsolutePath(
      subpath ? pathPosix.join(cwd, subpath) : cwd,
      "fs sandbox project roots path",
    );
  }
  if (kind === "slash_tmp" || kind === "tmpdir") {
    return "/tmp";
  }
  throw new Error(`Unsupported Codex fs sandbox special path: ${kind}`);
}

/** Asserts access against an already resolved filesystem sandbox policy. */
export function assertResolvedFsSandboxAccess(
  policy: ResolvedFsSandboxPolicy | undefined,
  requests: Array<{ path: string; access: "read" | "write" }>,
): void {
  if (!policy?.unrestricted && policy) {
    for (const request of requests) {
      const access = resolveFsAccess(policy, request.path);
      if (request.access === "read" ? access === "none" : access !== "write") {
        throw new Error(`Codex fs sandbox denied ${request.access} access to ${request.path}`);
      }
    }
  }
}

function resolveFsAccess(policy: ResolvedFsSandboxPolicy, rawPath: string): FsAccessMode {
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  let selected: { specificity: number; rank: number; access: FsAccessMode } | undefined;
  for (const entry of policy.entries) {
    const matches =
      entry.kind === "path" ? pathContains(entry.path, target) : entry.matcher(target);
    if (!matches) {
      continue;
    }
    const prefix = entry.kind === "path" ? entry.path : entry.literalPrefix;
    const candidate = {
      specificity: prefix.split("/").filter(Boolean).length,
      rank: FS_ACCESS_RANK[entry.access],
      access: entry.access,
    };
    if (
      !selected ||
      candidate.specificity > selected.specificity ||
      (candidate.specificity === selected.specificity && candidate.rank > selected.rank)
    ) {
      selected = candidate;
    }
  }
  return selected?.access ?? "none";
}

/** Rejects recursive writes/removes that would cross protected read-only descendants. */
export function assertNoReadOnlyDescendant(
  policy: ResolvedFsSandboxPolicy | undefined,
  rawPath: string,
  operation: string,
): void {
  if (!policy || policy.unrestricted) {
    return;
  }
  const target = normalizeSandboxAbsolutePath(rawPath, "fs path");
  const protectedDescendant = policy.entries.find((entry) => {
    if (entry.access === "write") {
      return false;
    }
    if (entry.kind === "glob") {
      return pathContains(target, entry.literalPrefix) || pathContains(entry.literalPrefix, target);
    }
    const protectedPath = entry.path;
    return (
      pathContains(target, protectedPath) &&
      target !== protectedPath &&
      protectedPath &&
      resolveFsAccess(policy, protectedPath) !== "write"
    );
  });
  if (protectedDescendant) {
    const protectedPath =
      protectedDescendant.kind === "path" ? protectedDescendant.path : protectedDescendant.pattern;
    throw new Error(
      `Codex fs sandbox denied recursive ${operation} of ${rawPath} because ${protectedPath} is not writable.`,
    );
  }
}

/** Normalizes and validates an absolute POSIX path inside the sandbox namespace. */
export function normalizeSandboxAbsolutePath(rawPath: string, label: string): string {
  if (!rawPath || rawPath.includes("\0") || !rawPath.startsWith("/")) {
    throw new Error(`${label} must be an absolute sandbox path.`);
  }
  return pathPosix.normalize(rawPath);
}

export function pathContains(root: string, target: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

function normalizeSandboxGlobPattern(pattern: string): string {
  if (!pattern || pattern.includes("\0") || !pattern.startsWith("/")) {
    throw new Error("fs sandbox glob pattern must be absolute.");
  }
  return pattern.replace(/\/{2,}/gu, "/");
}

type SandboxGlobLiteral = { kind: "literal"; points: string[]; fallback: number[] };

type SandboxGlobToken =
  | SandboxGlobLiteral
  | { kind: "star" }
  | { kind: "globstar" }
  | { kind: "globstarSlash" }
  | { kind: "single"; matches: (char: string) => boolean };

type SandboxGlobCursorRange = { start: number; end: number };

function compileSandboxGlobLiteral(text: string): SandboxGlobLiteral {
  const points = Array.from(text);
  const fallback = Array.from({ length: points.length }, () => 0);
  let matched = 0;
  for (let index = 1; index < points.length; index += 1) {
    while (matched > 0 && points[index] !== points[matched]) {
      matched = fallback[matched - 1] ?? 0;
    }
    if (points[index] === points[matched]) {
      matched += 1;
    }
    fallback[index] = matched;
  }
  return { kind: "literal", points, fallback };
}

function tokenizeSandboxGlobPattern(pattern: string): SandboxGlobToken[] {
  // Lex with the same rules as the previous regex compiler: `**/` is an
  // optional multi-segment prefix, `**` crosses separators, `*` and `?` stay
  // inside one segment, and `[...]` keeps its regex character-class semantics.
  const tokens: SandboxGlobToken[] = [];
  let literal = "";
  const flushLiteral = () => {
    if (literal) {
      tokens.push(compileSandboxGlobLiteral(literal));
      literal = "";
    }
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      flushLiteral();
      tokens.push({ kind: "globstarSlash" });
      index += 2;
    } else if (char === "*" && next === "*") {
      flushLiteral();
      tokens.push({ kind: "globstar" });
      index += 1;
    } else if (char === "*") {
      flushLiteral();
      tokens.push({ kind: "star" });
    } else if (char === "?") {
      flushLiteral();
      tokens.push({ kind: "single", matches: (targetChar) => targetChar !== "/" });
    } else if (char === "[") {
      flushLiteral();
      const compiledClass = compileSandboxGlobCharacterClass(pattern, index);
      // A character class never backtracks; testing one code point against it
      // stays linear while preserving the class semantics the regex compiler
      // had under the unicode flag.
      const classPattern = new RegExp(compiledClass.source, "u");
      tokens.push({ kind: "single", matches: (targetChar) => classPattern.test(targetChar) });
      index = compiledClass.endIndex;
    } else {
      literal += char ?? "";
    }
  }
  flushLiteral();
  return tokens;
}

// Cursor positions index Unicode code points, matching the `u`-flag regex the
// tokenizer replaces: an astral char is one cursor step, never a surrogate
// half. Literal tokens use the same code-point indexing.
// `slashFollowRanges` precomputes positions just past each separator so `**/`
// tokens merge them in without rescanning the target per cursor range.
// `lineTerminators` lists LF/CR/U+2028/U+2029 points: the old regex compiled
// globstars from `.`, which cannot consume those even with the `u` flag, so
// globstar reach stops before each of them.
type SandboxGlobTarget = {
  points: string[];
  slashFollowRanges: SandboxGlobCursorRange[];
  lineTerminators: number[];
};

function isSandboxGlobLineTerminator(point: string): boolean {
  return point === "\n" || point === "\r" || point === "\u2028" || point === "\u2029";
}

function firstLineTerminatorAtOrAfter(target: SandboxGlobTarget, index: number): number {
  let low = 0;
  let high = target.lineTerminators.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((target.lineTerminators[mid] ?? 0) < index) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low < target.lineTerminators.length
    ? (target.lineTerminators[low] ?? 0)
    : target.points.length;
}

function createSandboxGlobTarget(url: string): SandboxGlobTarget {
  // Array.from iterates Unicode code points, matching the `u`-flag regex the
  // tokenizer replaces; Intl.Segmenter graphemes would diverge from it.
  const points = Array.from(url);
  const slashFollows: number[] = [];
  const lineTerminators: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] ?? "";
    if (point === "/") {
      slashFollows.push(index + 1);
    } else if (isSandboxGlobLineTerminator(point)) {
      lineTerminators.push(index);
    }
  }
  const slashFollowRanges: SandboxGlobCursorRange[] = [];
  for (const follow of slashFollows) {
    const last = slashFollowRanges.at(-1);
    if (last !== undefined && follow === last.end + 1) {
      last.end = follow;
    } else {
      slashFollowRanges.push({ start: follow, end: follow });
    }
  }
  return { points, slashFollowRanges, lineTerminators };
}

// Merges two sorted, disjoint range lists in linear time; globstar-slash
// feeds the current ranges plus sorted separator-follows, so a full re-sort
// per token is unnecessary.
function mergeSortedSandboxGlobRanges(
  left: readonly SandboxGlobCursorRange[],
  right: readonly SandboxGlobCursorRange[],
): SandboxGlobCursorRange[] {
  const merged: SandboxGlobCursorRange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftRange = left[leftIndex];
    const rightRange = right[rightIndex];
    const range =
      rightRange === undefined ||
      (leftRange !== undefined &&
        (leftRange.start < rightRange.start ||
          (leftRange.start === rightRange.start && leftRange.end <= rightRange.end)))
        ? leftRange
        : rightRange;
    if (range === undefined) {
      break;
    }
    if (range === leftRange) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) {
        last.end = range.end;
      }
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function mergeSandboxGlobRanges(ranges: SandboxGlobCursorRange[]): SandboxGlobCursorRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: SandboxGlobCursorRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) {
        last.end = range.end;
      }
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function literalSandboxGlobRanges(
  target: SandboxGlobTarget,
  literal: SandboxGlobLiteral,
  ranges: readonly SandboxGlobCursorRange[],
): SandboxGlobCursorRange[] {
  const next: SandboxGlobCursorRange[] = [];
  const first = ranges[0];
  const last = ranges.at(-1);
  if (!first || !last) {
    return next;
  }
  // KMP retains matched prefixes, including overlapping occurrences, instead
  // of comparing a potentially long literal again at every reachable cursor.
  const limit = Math.min(target.points.length, last.end + literal.points.length);
  let matched = 0;
  let rangeIndex = 0;
  for (let pos = first.start; pos < limit; pos += 1) {
    const point = target.points[pos];
    while (matched > 0 && point !== literal.points[matched]) {
      matched = literal.fallback[matched - 1] ?? 0;
    }
    if (point === literal.points[matched]) {
      matched += 1;
    }
    if (matched !== literal.points.length) {
      continue;
    }
    const start = pos + 1 - matched;
    matched = literal.fallback[matched - 1] ?? 0;
    while (rangeIndex < ranges.length && (ranges[rangeIndex]?.end ?? -1) < start) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    if (!range || start < range.start) {
      continue;
    }
    const previous = next.at(-1);
    if (previous && previous.end === pos) {
      previous.end = pos + 1;
    } else {
      next.push({ start: pos + 1, end: pos + 1 });
    }
  }
  return next;
}

// `*` stays inside one path segment. The first cursor in a segment already
// reaches that segment's end, so later cursors in the same segment are not
// scanned again.
function starSandboxGlobRanges(
  points: readonly string[],
  ranges: readonly SandboxGlobCursorRange[],
): SandboxGlobCursorRange[] {
  const next: SandboxGlobCursorRange[] = [];
  let coveredThrough = -1;
  for (const range of mergeSandboxGlobRanges(
    ranges.map((item) => ({ start: item.start, end: item.end })),
  )) {
    let cursor = range.start;
    if (cursor <= coveredThrough) {
      cursor = coveredThrough + 1;
    }
    while (cursor <= range.end) {
      let far = cursor;
      while (far < points.length && points[far] !== "/") {
        far += 1;
      }
      next.push({ start: cursor, end: far });
      coveredThrough = far;
      if (far >= range.end) {
        break;
      }
      cursor = far + 1;
    }
  }
  return mergeSandboxGlobRanges(next);
}

// `**` compiles from `.`, which without the dotAll flag stops at line
// terminators: every cursor reaches each position up to the next line
// terminator after that cursor's range end.
function globstarSandboxGlobRanges(
  target: SandboxGlobTarget,
  ranges: readonly SandboxGlobCursorRange[],
): SandboxGlobCursorRange[] {
  const next: SandboxGlobCursorRange[] = [];
  for (const range of ranges) {
    next.push({
      start: range.start,
      end: firstLineTerminatorAtOrAfter(target, range.end),
    });
  }
  return mergeSandboxGlobRanges(next);
}

// `**/` may match empty or consume through any later separator, so cursors
// stay put or jump to just past a separator. The consumed prefix compiles
// from `.` and cannot cross a line terminator, so separator-follows past the
// next line terminator from a cursor are unreachable from that cursor. Each
// follow is emitted once: range starts are non-decreasing, so a monotone
// table pointer covers the union without rescanning per range.
function globstarSlashSandboxGlobRanges(
  target: SandboxGlobTarget,
  ranges: readonly SandboxGlobCursorRange[],
): SandboxGlobCursorRange[] {
  const follows = target.slashFollowRanges;
  const next: SandboxGlobCursorRange[] = [];
  const emitted: SandboxGlobCursorRange[] = [];
  let followIndex = 0;
  const sortedRanges = ranges.toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (const range of sortedRanges) {
    next.push({ start: range.start, end: range.end });
    const bound = firstLineTerminatorAtOrAfter(target, range.end);
    while (followIndex < follows.length) {
      const follow = follows[followIndex];
      if (follow === undefined || follow.start > range.start) {
        break;
      }
      followIndex += 1;
    }
    while (followIndex < follows.length) {
      const follow = follows[followIndex];
      if (follow === undefined || follow.start > bound) {
        break;
      }
      emitted.push({ start: follow.start, end: follow.end });
      followIndex += 1;
    }
  }
  return mergeSortedSandboxGlobRanges(next, emitted);
}

// `?` and `[...]` consume exactly one code point, so cursors move to just past
// each matching point without revisiting scanned text.
function singleSandboxGlobRanges(
  points: readonly string[],
  ranges: readonly SandboxGlobCursorRange[],
  matches: (char: string) => boolean,
): SandboxGlobCursorRange[] {
  const next: SandboxGlobCursorRange[] = [];
  for (const range of ranges) {
    let runStart = -1;
    let runEnd = -1;
    const last = Math.min(range.end, points.length - 1);
    for (let pos = range.start; pos <= last; pos += 1) {
      const point = points[pos];
      if (point === undefined || !matches(point)) {
        continue;
      }
      const at = pos + 1;
      if (runStart < 0) {
        runStart = at;
        runEnd = at;
      } else if (at === runEnd + 1) {
        runEnd = at;
      } else {
        next.push({ start: runStart, end: runEnd });
        runStart = at;
        runEnd = at;
      }
    }
    if (runStart >= 0) {
      next.push({ start: runStart, end: runEnd });
    }
  }
  return mergeSandboxGlobRanges(next);
}

function matchSandboxGlobTokens(url: string, tokens: readonly SandboxGlobToken[]): boolean {
  const target = createSandboxGlobTarget(url);
  let ranges: SandboxGlobCursorRange[] = [{ start: 0, end: 0 }];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token.kind === "literal") {
      ranges = literalSandboxGlobRanges(target, token, ranges);
    } else if (token.kind === "star") {
      ranges = starSandboxGlobRanges(target.points, ranges);
    } else if (token.kind === "globstar") {
      ranges = globstarSandboxGlobRanges(target, ranges);
    } else if (token.kind === "globstarSlash") {
      ranges = globstarSlashSandboxGlobRanges(target, ranges);
      // A globstar-slash is idempotent on its own output: separator-follows
      // within reach were already merged, so a run of adjacent tokens
      // collapses into one pass.
      while (tokens[index + 1]?.kind === "globstarSlash") {
        index += 1;
      }
    } else {
      ranges = singleSandboxGlobRanges(target.points, ranges, token.matches);
    }
    if (ranges.length === 0) {
      return false;
    }
  }
  return ranges.some(
    (range) => range.start <= target.points.length && target.points.length <= range.end,
  );
}

/**
 * Compiles a Codex sandbox glob into a linear matcher. The sandbox context is
 * model-session output and the target path is model-requested, so the matcher
 * must stay free of catastrophic backtracking: each token advances cursor
 * ranges in one pass instead of letting a regex retry overlapping quantifiers.
 */
function compileSandboxGlobMatcher(pattern: string): (target: string) => boolean {
  const tokens = tokenizeSandboxGlobPattern(pattern);
  return (target) => matchSandboxGlobTokens(target, tokens);
}

function compileSandboxGlobCharacterClass(
  pattern: string,
  startIndex: number,
): { source: string; endIndex: number } {
  let index = startIndex + 1;
  if (index >= pattern.length) {
    throw new Error("fs sandbox glob character class must be closed.");
  }
  const negated = pattern[index] === "!" || pattern[index] === "^";
  if (negated) {
    index += 1;
  }
  let body = "";
  for (; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "]" && body) {
      return {
        source: `[${negated ? "^" : ""}${body}]`,
        endIndex: index,
      };
    }
    if (!char || char === "/") {
      throw new Error("fs sandbox glob character class cannot match path separators.");
    }
    body +=
      char === "\\" || char === "]" || (body.length === 0 && char === "^") ? `\\${char}` : char;
  }
  throw new Error("fs sandbox glob character class must be closed.");
}

function sandboxGlobLiteralPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?[]/u);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  const slash = prefix.lastIndexOf("/");
  if (slash <= 0) {
    return "/";
  }
  return normalizeSandboxAbsolutePath(prefix.slice(0, slash), "fs sandbox glob prefix");
}

/** Safely joins a single directory entry name onto a sandbox parent path. */
export function joinSandboxChildPath(parent: string, child: string): string {
  if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\0")) {
    throw new Error(`Invalid sandbox directory entry name: ${child}`);
  }
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}
