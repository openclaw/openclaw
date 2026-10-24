/**
 * Universal `setOcPath` / `resolveOcPath` / `detectInsertion`.
 * Addressing is universal; encoding is per-kind. Callers pass any AST
 * + path + value; the substrate dispatches on `ast.kind` and coerces
 * the value based on the AST shape at the resolution point. Wildcard,
 * union, and predicate expansion belong to `findOcPaths`; `resolveOcPath`
 * and `setOcPath` require concrete paths.
 *
 *   oc://FILE/section/item/field   → leaf address
 *   oc://FILE/section/+            → end-insertion
 *   oc://FILE/section/+key         → keyed insertion
 *   oc://FILE/section/+0           → indexed insertion
 *   oc://FILE/+                    → file-root insertion
 *
 * @module @openclaw/oc-path/universal
 */

import { isMap, isSeq, type Node } from "yaml";
import type { MdAst } from "./ast.js";
import { OcPathEditError } from "./edit-error.js";
import { setMdOcPath } from "./edit.js";
import { insertMdSource } from "./emit.js";
import { formatFrontmatterValue } from "./frontmatter-format.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./jsonc/ast.js";
import { insertJsoncOcPath, setJsoncOcPath } from "./jsonc/edit.js";
import { resolveJsoncOcPath } from "./jsonc/resolve.js";
import type { JsonlAst } from "./jsonl/ast.js";
import { appendJsonlOcPath as appendJsonlLine, setJsonlOcPath } from "./jsonl/edit.js";
import { resolveJsonlOcPath } from "./jsonl/resolve.js";
import type { OcPath } from "./oc-path.js";
import { formatOcPath, isPattern, OcPathError } from "./oc-path.js";
import { parseMdItemKeyValue } from "./parse.js";
import { resolveMdOcPath } from "./resolve.js";
import { guardSentinel } from "./sentinel.js";
import { slugify } from "./slug.js";
import { sourceLineOffset } from "./source.js";
import type { YamlAst } from "./yaml/ast.js";
import { insertYamlOcPath, setYamlOcPath } from "./yaml/edit.js";
import { resolveYamlOcPath } from "./yaml/resolve.js";

export type OcAst = MdAst | JsoncAst | JsonlAst | YamlAst;

/**
 * Universal resolve result — same shape across AST kinds. `leaf` values
 * are string-coerced (numbers/bools stringified deterministically).
 * `line` is 1-based; root/synthetic nodes use `1`.
 */
export type OcMatch =
  | { readonly kind: "root"; readonly ast: OcAst; readonly line: number }
  | {
      readonly kind: "leaf";
      readonly valueText: string;
      readonly leafType: LeafType;
      readonly line: number;
    }
  | { readonly kind: "node"; readonly descriptor: NodeDescriptor; readonly line: number }
  | { readonly kind: "insertion-point"; readonly container: ContainerKind; readonly line: number };

type InsertionMatch = Extract<OcMatch, { kind: "insertion-point" }>;

type LeafType = "string" | "number" | "boolean" | "null";

type NodeDescriptor =
  | "md-block"
  | "md-item"
  | "jsonc-object"
  | "jsonc-array"
  | "jsonl-line"
  | "yaml-map"
  | "yaml-seq";

type ContainerKind =
  | "md-section"
  | "md-file"
  | "md-frontmatter"
  | "jsonc-object"
  | "jsonc-array"
  | "jsonl-file"
  | "yaml-map"
  | "yaml-seq";

type SetOcPathOptions = {
  readonly valueJson?: boolean;
};

/**
 * Insertion marker on the deepest path segment: `+`, `+<key>`, or
 * `+<index>`. Returns parent path + marker; null for plain paths.
 */
interface InsertionInfo {
  readonly parentPath: OcPath;
  readonly marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number };
}

function detectInsertion(path: OcPath): InsertionInfo | null {
  const slot = path.field !== undefined ? "field" : path.item !== undefined ? "item" : "section";
  const value = path[slot];
  if (!value?.startsWith("+")) {
    return null;
  }

  const rest = value.slice(1);
  const marker: InsertionInfo["marker"] =
    rest.length === 0
      ? "+"
      : /^\d+$/.test(rest)
        ? { kind: "indexed", index: Number(rest) }
        : { kind: "keyed", key: rest };

  const parentPath: OcPath = {
    file: path.file,
    ...(slot !== "section" && path.section !== undefined ? { section: path.section } : {}),
    ...(slot !== "item" && path.item !== undefined ? { item: path.item } : {}),
    ...(slot !== "field" && path.field !== undefined ? { field: path.field } : {}),
    ...(path.session !== undefined ? { session: path.session } : {}),
  };
  return { parentPath, marker };
}

export function resolveOcPath(ast: OcAst, path: OcPath): OcMatch | null {
  // Single-match verb: wildcards belong to findOcPaths. Throw with a
  // structured code so consumers can route to the right verb.
  if (isPattern(path)) {
    throw new OcPathError(
      `resolveOcPath received a wildcard pattern; use findOcPaths instead: ${formatOcPath(path)}`,
      "OC_PATH_WILDCARD_IN_RESOLVE",
    );
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {
    return resolveInsertion(ast, insertion);
  }

  if (ast.kind === "md") {
    return resolveMdToUniversal(ast, path);
  }
  if (ast.kind === "jsonc") {
    return resolveJsoncToUniversal(ast, path);
  }
  if (ast.kind === "jsonl") {
    return resolveJsonlToUniversal(ast, path);
  }
  return resolveYamlToUniversal(ast, path);
}

function resolveUniversalRoot(ast: OcAst, match: { kind: "root" } | null): OcMatch | null {
  return match === null ? null : { kind: "root", ast, line: 1 };
}

function resolveMdToUniversal(ast: MdAst, path: OcPath): OcMatch | null {
  const m = resolveMdOcPath(ast, path);
  if (m === null || m.kind === "root") {
    return resolveUniversalRoot(ast, m);
  }
  if (m.kind === "frontmatter") {
    return { kind: "leaf", valueText: m.node.value, leafType: "string", line: m.node.line };
  }
  if (m.kind === "block" || m.kind === "item") {
    return { kind: "node", descriptor: `md-${m.kind}`, line: m.node.line };
  }
  return { kind: "leaf", valueText: m.value, leafType: "string", line: m.node.line };
}

function resolveJsoncToUniversal(ast: JsoncAst, path: OcPath): OcMatch | null {
  const m = resolveJsoncOcPath(ast, path);
  if (m === null || m.kind === "root") {
    return resolveUniversalRoot(ast, m);
  }
  if (m.kind === "object-entry") {
    return jsoncValueToMatch(m.node.value, m.node.line);
  }
  return jsoncValueToMatch(m.node, m.node.line ?? 1);
}

function jsoncValueToMatch(value: JsoncValue, line: number): OcMatch {
  if (value.kind === "object" || value.kind === "array") {
    return { kind: "node", descriptor: `jsonc-${value.kind}`, line };
  }
  return {
    kind: "leaf",
    valueText: value.kind === "null" ? "null" : String(value.value),
    leafType: value.kind,
    line,
  };
}

function resolveJsonlToUniversal(ast: JsonlAst, path: OcPath): OcMatch | null {
  const m = resolveJsonlOcPath(ast, path);
  if (m === null || m.kind === "root") {
    return resolveUniversalRoot(ast, m);
  }
  if (m.kind === "line") {
    return { kind: "node", descriptor: "jsonl-line", line: m.node.line };
  }
  // Inside-line jsonc nodes always have line=1; use the JsonlLine's
  // file-level line instead since every inside-line node sits there.
  if (m.kind === "object-entry") {
    return jsoncValueToMatch(m.node.value, m.line);
  }
  return jsoncValueToMatch(m.node, m.line);
}

function resolveYamlToUniversal(ast: YamlAst, path: OcPath): OcMatch | null {
  const m = resolveYamlOcPath(ast, path);
  if (m === null || m.kind === "root") {
    return resolveUniversalRoot(ast, m);
  }
  if (m.kind === "scalar" || m.kind === "pair") {
    return yamlScalarToMatch(m.value, yamlLine(ast, m.node));
  }
  return { kind: "node", descriptor: `yaml-${m.kind}`, line: yamlLine(ast, m.node) };
}

function yamlScalarToMatch(value: unknown, line: number): OcMatch {
  const leafType = typeof value;
  if (leafType === "number" || leafType === "boolean") {
    return { kind: "leaf", valueText: String(value), leafType, line };
  }
  if (value === null) {
    return { kind: "leaf", valueText: "null", leafType: "null", line };
  }
  return { kind: "leaf", valueText: yamlScalarToText(value), leafType: "string", line };
}

function yamlScalarToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value) ?? "";
}

function yamlLine(ast: YamlAst, node: Node): number {
  const range = node.range;
  return range ? ast.lineCounter.linePos(range[0]).line : 1;
}

function resolveInsertion(ast: OcAst, info: InsertionInfo): InsertionMatch | null {
  if (ast.kind === "md") {
    return resolveMdInsertion(ast, info);
  }
  if (ast.kind === "jsonc") {
    return resolveJsoncInsertion(ast, info);
  }
  if (ast.kind === "jsonl") {
    return resolveJsonlInsertion(ast, info);
  }
  return resolveYamlInsertion(ast, info);
}

function resolveMdInsertion(ast: MdAst, info: InsertionInfo): InsertionMatch | null {
  const p = info.parentPath;
  if (p.section === undefined) {
    return { kind: "insertion-point", container: "md-file", line: 1 };
  }
  if (p.section === "[frontmatter]") {
    return { kind: "insertion-point", container: "md-frontmatter", line: 1 };
  }
  if (p.item === undefined && p.field === undefined) {
    const m = resolveMdOcPath(ast, p);
    if (m === null || m.kind !== "block") {
      return null;
    }
    return { kind: "insertion-point", container: "md-section", line: m.node.line };
  }
  return null;
}

function resolveJsoncInsertion(ast: JsoncAst, info: InsertionInfo): InsertionMatch | null {
  const m = resolveJsoncOcPath(ast, info.parentPath);
  if (m === null) {
    return null;
  }
  let containerNode: JsoncValue;
  if (m.kind === "root") {
    if (ast.root === null) {
      return null;
    }
    containerNode = ast.root;
  } else if (m.kind === "object-entry") {
    containerNode = m.node.value;
  } else {
    containerNode = m.node;
  }
  const line = containerNode.line ?? 1;
  if (containerNode.kind === "object" || containerNode.kind === "array") {
    return { kind: "insertion-point", container: `jsonc-${containerNode.kind}`, line };
  }
  return null;
}

function resolveJsonlInsertion(ast: JsonlAst, info: InsertionInfo): InsertionMatch | null {
  // jsonl insertion only makes sense at file level (`oc://FILE/+`).
  // Surfaced line is lastLine+1 so consumers render correctly.
  if (info.parentPath.section !== undefined) {
    return null;
  }
  const lastLine = ast.lines.at(-1)?.line ?? 0;
  return { kind: "insertion-point", container: "jsonl-file", line: lastLine + 1 };
}

function resolveYamlInsertion(ast: YamlAst, info: InsertionInfo): InsertionMatch | null {
  const m = resolveYamlOcPath(ast, info.parentPath);
  if (m === null) {
    return null;
  }
  if (m.kind === "root") {
    const root = ast.doc.contents;
    if (isMap(root)) {
      return { kind: "insertion-point", container: "yaml-map", line: 1 };
    }
    if (isSeq(root)) {
      return { kind: "insertion-point", container: "yaml-seq", line: 1 };
    }
    return null;
  }
  if (m.kind === "pair" || m.kind === "scalar") {
    return null;
  }
  return { kind: "insertion-point", container: `yaml-${m.kind}`, line: yamlLine(ast, m.node) };
}

/**
 * Replace or insert at `path`. Coerces value at leaves based on the
 * existing AST shape; for insertion paths value is parsed as
 * kind-appropriate content (JSON for jsonc/jsonl; raw text for md).
 * Sentinel-guard violations throw `OcEmitSentinelError`.
 */
export function setOcPath(
  ast: OcAst,
  path: OcPath,
  value: string,
  options: SetOcPathOptions = {},
): OcAst {
  if (isPattern(path)) {
    throw new OcPathEditError(
      "wildcard-not-allowed",
      "setOcPath requires a concrete path; use findOcPaths to enumerate matches first",
    );
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {
    if (ast.kind === "md") {
      guardSentinel(value, () => formatOcPath(path));
      return setMdInsertion(ast, insertion, value);
    }
    if (ast.kind === "jsonc") {
      return setJsoncInsertion(ast, insertion, value);
    }
    if (ast.kind === "jsonl") {
      return setJsonlInsertion(ast, insertion, value);
    }
    return setYamlInsertion(ast, insertion, value);
  }
  if (ast.kind === "md") {
    return setMdOcPath(ast, path, value);
  }
  if (ast.kind === "jsonc" || ast.kind === "jsonl") {
    return setStructuredLeaf(ast, path, value, options);
  }
  return setYamlLeaf(ast, path, value);
}

function setStructuredLeaf(
  ast: JsoncAst | JsonlAst,
  path: OcPath,
  value: string,
  options: SetOcPathOptions,
): OcAst {
  const existing =
    ast.kind === "jsonc" ? resolveJsoncOcPath(ast, path) : resolveJsonlOcPath(ast, path);
  if (existing === null) {
    throw new OcPathEditError("unresolved");
  }
  if (existing.kind === "root") {
    throw new OcPathEditError("not-writable", "root replacement is not supported via setOcPath");
  }
  const set = (replacement: JsoncValue) =>
    ast.kind === "jsonc"
      ? setJsoncOcPath(ast, path, replacement)
      : setJsonlOcPath(ast, path, replacement);
  if (existing.kind === "line") {
    const parsed = parseJsonInput(value, "line replacement");
    return set(parsed);
  }
  const leafValue = existing.kind === "object-entry" ? existing.node.value : existing.node;
  const coerced =
    options.valueJson === true
      ? parseJsoncReplacement(value, leafValue)
      : coerceJsoncLeaf(value, leafValue);
  if (coerced === null) {
    throw new OcPathEditError("parse-error", `cannot coerce "${value}" to ${leafValue.kind}`);
  }
  return set(coerced);
}

function parseJsoncReplacement(valueText: string, existing: JsoncValue): JsoncValue | null {
  const parsed = tryParseJson(valueText);
  if (parsed === undefined) {
    return null;
  }
  const parsedValue = jsonToJsoncValue(parsed);
  if (parsedValue === null) {
    return null;
  }
  return existing.line === undefined ? parsedValue : { ...parsedValue, line: existing.line };
}

function setMdInsertion(ast: MdAst, info: InsertionInfo, value: string): OcAst {
  const p = info.parentPath;
  // file-level: append a section. Value is the heading text; body empty.
  if (p.section === undefined) {
    if (info.marker !== "+") {
      throw new OcPathEditError("not-writable", "md file-level insertion uses bare `+`");
    }
    const gap = ast.raw.replace(/^\uFEFF/, "").length > 0 && !/\n\r?\n$/.test(ast.raw) ? "\n" : "";
    return insertMdSource(ast, ast.raw.length, `${gap}## ${value}`, (shifted, line) => ({
      ...shifted,
      blocks: [
        ...shifted.blocks,
        {
          heading: value,
          slug: slugify(value),
          line: line + gap.length,
          bodyText: "",
          items: [],
        },
      ],
    }));
  }

  if (p.section === "[frontmatter]") {
    if (typeof info.marker !== "object" || info.marker.kind !== "keyed") {
      throw new OcPathEditError("not-writable", "md frontmatter insertion requires +key");
    }
    const key = info.marker.key;
    if (ast.frontmatter.some((e) => e.key === key)) {
      throw new OcPathEditError(
        "type-mismatch",
        `frontmatter key '${key}' already exists; use set, not insert`,
      );
    }
    const endLine = ast.frontmatterEndLine;
    const hasFrontmatter = endLine !== undefined;
    const offset =
      endLine !== undefined
        ? sourceLineOffset(ast.raw, endLine)
        : ast.raw.startsWith("\uFEFF")
          ? 1
          : 0;
    const entry = `${key}: ${formatFrontmatterValue(value)}`;
    return insertMdSource(
      ast,
      offset,
      hasFrontmatter ? entry : `---\n${entry}\n---`,
      (shifted, line) => ({
        ...shifted,
        frontmatterEndLine: hasFrontmatter ? shifted.frontmatterEndLine : line + 2,
        frontmatter: [
          ...shifted.frontmatter,
          { key, value, line: line + (hasFrontmatter ? 0 : 1) },
        ],
      }),
    );
  }

  // section-level: append item. Value can be `key: value` (kv) or plain text.
  if (p.item === undefined && p.field === undefined) {
    if (info.marker !== "+") {
      throw new OcPathEditError("not-writable", "md section insertion uses bare `+`");
    }
    const match = resolveMdOcPath(ast, p);
    if (match?.kind !== "block") {
      throw new OcPathEditError("unresolved");
    }
    const blockIdx = ast.blocks.indexOf(match.node);
    const kv = parseMdItemKeyValue(value);
    const itemLine = `- ${value}`;
    const nextBlock = ast.blocks[blockIdx + 1];
    const offset = nextBlock ? sourceLineOffset(ast.raw, nextBlock.line) : ast.raw.length;
    return insertMdSource(ast, offset, itemLine, (shifted, line) => ({
      ...shifted,
      blocks: shifted.blocks.map((entry, index) =>
        index !== blockIdx
          ? entry
          : {
              ...entry,
              items: [
                ...entry.items,
                {
                  text: value,
                  slug: slugify(kv?.key ?? value),
                  line,
                  ...(kv === undefined ? {} : { kv }),
                },
              ],
            },
      ),
    }));
  }

  throw new OcPathEditError("not-writable");
}

function setJsoncInsertion(ast: JsoncAst, info: InsertionInfo, value: string): OcAst {
  const containerMatch = resolveJsoncInsertion(ast, info);
  if (containerMatch === null) {
    throw new OcPathEditError("unresolved");
  }

  const parsed = parseJsonInput(value, "jsonc insertion");
  if (containerMatch.container === "jsonc-array") {
    // `+0` indexed; bare `+` appends; `+key` rejected for arrays.
    if (typeof info.marker === "object" && info.marker.kind === "keyed") {
      throw new OcPathEditError("type-mismatch", "cannot insert by key into array");
    }
    const index = info.marker === "+" ? -1 : info.marker.index;
    return insertJsoncOcPath(ast, info.parentPath, index, parsed);
  }

  if (typeof info.marker !== "object" || info.marker.kind !== "keyed") {
    throw new OcPathEditError("type-mismatch", "jsonc object insertion requires +key");
  }
  return insertJsoncOcPath(ast, info.parentPath, info.marker.key, parsed);
}

function setJsonlInsertion(ast: JsonlAst, info: InsertionInfo, value: string): OcAst {
  if (info.parentPath.section !== undefined || info.marker !== "+") {
    throw new OcPathEditError("not-writable", "jsonl insertion only supports oc://FILE/+ append");
  }
  const parsed = parseJsonInput(value, "jsonl line append");
  return appendJsonlLine(ast, parsed);
}

function setYamlLeaf(ast: YamlAst, path: OcPath, value: string): OcAst {
  if (ast.doc.errors.length > 0) {
    throw new OcPathEditError("parse-error");
  }
  const existing = resolveYamlOcPath(ast, path);
  if (existing === null) {
    throw new OcPathEditError("unresolved");
  }
  if (existing.kind === "root" || existing.kind === "map" || existing.kind === "seq") {
    throw new OcPathEditError("not-writable");
  }
  const current = existing.value;
  const coerced = coerceYamlValue(value, current);
  if (coerced === undefined) {
    throw new OcPathEditError("parse-error", `cannot coerce "${value}" to ${typeof current}`);
  }
  return setYamlOcPath(ast, path, coerced);
}

function setYamlInsertion(ast: YamlAst, info: InsertionInfo, value: string): OcAst {
  if (ast.doc.errors.length > 0) {
    throw new OcPathEditError("parse-error");
  }
  return insertYamlOcPath(ast, info.parentPath, info.marker, parseYamlInput(value));
}

function coerceYamlValue(value: string, current: unknown): unknown {
  if (typeof current === "number") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      return undefined;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof current === "boolean") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return undefined;
  }
  if (current === null) {
    return value === "null" ? null : undefined;
  }
  return value;
}

function parseYamlInput(value: string): unknown {
  const parsed = tryParseJson(value);
  return parsed === undefined ? value : parsed;
}

// Preserve the existing source line on coerced replacements — same
// semantic node, only the bytes change.
function coerceJsoncLeaf(valueText: string, existing: JsoncValue): JsoncValue | null {
  const lineExt = existing.line !== undefined ? { line: existing.line } : {};
  if (existing.kind === "string") {
    return { kind: "string", value: valueText, ...lineExt };
  }
  if (existing.kind === "number") {
    const n = Number(valueText);
    return Number.isFinite(n) ? { kind: "number", value: n, ...lineExt } : null;
  }
  if (existing.kind === "boolean") {
    if (valueText === "true") {
      return { kind: "boolean", value: true, ...lineExt };
    }
    if (valueText === "false") {
      return { kind: "boolean", value: false, ...lineExt };
    }
    return null;
  }
  if (existing.kind === "null") {
    return valueText === "null" ? { kind: "null", ...lineExt } : null;
  }
  // Object/array — caller should use insertion or full-replace.
  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseJsonInput(value: string, operation: string): JsoncValue {
  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    throw new OcPathEditError("parse-error", `${operation} requires JSON value`);
  }
  const node = jsonToJsoncValue(parsed);
  if (node === null) {
    throw new OcPathEditError("parse-error", `${operation} requires finite JSON value`);
  }
  return node;
}

function jsonToJsoncValue(v: unknown): JsoncValue | null {
  // Synthetic values omit `line` — only the parser sets line metadata.
  if (v === null) {
    return { kind: "null" };
  }
  if (typeof v === "string") {
    return { kind: "string", value: v };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      return null;
    }
    return { kind: "number", value: v };
  }
  if (typeof v === "boolean") {
    return { kind: "boolean", value: v };
  }
  if (Array.isArray(v)) {
    const items = v.map(jsonToJsoncValue);
    if (items.some((item) => item === null)) {
      return null;
    }
    return { kind: "array", items: items as JsoncValue[] };
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const entries: JsoncEntry[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const jsoncValue = jsonToJsoncValue(value);
      if (jsoncValue === null) {
        return null;
      }
      entries.push({
        key,
        value: jsoncValue,
        line: 0,
      });
    }
    return {
      kind: "object",
      entries,
    };
  }
  // JSON.parse never produces undefined / function / symbol.
  throw new Error(`unsupported JSON value type: ${typeof v}`);
}
