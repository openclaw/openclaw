import {
  applyEdits,
  findNodeAtLocation,
  format,
  type FormattingOptions,
  modify,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { OcPathEditError } from "../edit-error.js";
import type { OcPath } from "../oc-path.js";
import { splitOcPathSlots } from "../oc-path.js";
import { guardSentinel } from "../sentinel.js";
import type { JsoncAst, JsoncValue } from "./ast.js";
import { findEffectiveJsoncNode, parseJsonc } from "./parse.js";
import { resolveJsoncValueOcPath } from "./resolve-value.js";

type JsoncEditPath = Array<string | number>;
const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2 };

type JsoncEditTarget = { readonly path: JsoncEditPath; readonly value: JsoncValue };

export function setJsoncOcPath(ast: JsoncAst, path: OcPath, newValue: JsoncValue): JsoncAst {
  if (ast.root === null) {
    throw new OcPathEditError("no-root");
  }

  const target = resolveEditTarget(ast.root, splitOcPathSlots(path.section, path.item, path.field));
  if (target === null) {
    throw new OcPathEditError("unresolved");
  }
  const tree = parseTree(ast.raw, [], { allowTrailingComma: true });
  const node = tree && findEffectiveJsoncNode(tree, target.path);
  if (!node) {
    throw new OcPathEditError("unresolved");
  }
  const content = JSON.stringify(
    jsoncValueToJson(newValue, `oc://${path.file}/${target.path.join("/")}`),
  );
  // Replace the effective node, then format the new range as jsonc-parser's modify does.
  const replaced = applyEdits(ast.raw, [{ offset: node.offset, length: node.length, content }]);
  const range = { offset: node.offset, length: content.length };
  return reparse(
    applyEdits(replaced, format(replaced, range, { ...FORMATTING, keepLines: false })),
  );
}

export function insertJsoncOcPath(
  ast: JsoncAst,
  parentPath: OcPath,
  indexOrKey: number | string,
  newValue: JsoncValue,
): JsoncAst {
  if (ast.root === null) {
    throw new OcPathEditError("no-root");
  }

  const target = resolveEditTarget(
    ast.root,
    splitOcPathSlots(parentPath.section, parentPath.item, parentPath.field),
  );
  if (target === null) {
    throw new OcPathEditError("unresolved");
  }
  if (typeof indexOrKey === "string") {
    if (
      target.value.kind !== "object" ||
      target.value.entries.some((entry) => entry.key === indexOrKey)
    ) {
      throw new OcPathEditError("unresolved");
    }
  } else if (target.value.kind !== "array") {
    throw new OcPathEditError("unresolved");
  }

  const tree = parseTree(ast.raw, [], { allowTrailingComma: true });
  if (tree && findNodeAtLocation(tree, target.path) !== findEffectiveJsoncNode(tree, target.path)) {
    throw new OcPathEditError(
      "not-writable",
      "insertion under a duplicated key is ambiguous; merge the duplicate keys into one (keeping the last, effective value), then retry the insertion",
    );
  }
  const segment = typeof indexOrKey === "number" && indexOrKey < 0 ? -1 : indexOrKey;
  const editPath = [...target.path, segment];
  return applyJsoncEdit(ast, editPath, newValue, typeof segment === "number", parentPath.file);
}

function applyJsoncEdit(
  ast: JsoncAst,
  path: JsoncEditPath,
  newValue: JsoncValue,
  isArrayInsertion: boolean,
  file: string,
): JsoncAst {
  const edits = modify(
    ast.raw,
    path,
    jsoncValueToJson(newValue, `oc://${file}/${path.join("/")}`),
    { formattingOptions: FORMATTING, isArrayInsertion },
  );
  if (edits.length === 0) {
    throw new OcPathEditError("unresolved");
  }
  return reparse(applyEdits(ast.raw, edits));
}

function reparse(nextRaw: string): JsoncAst {
  const reparsed = parseJsonc(nextRaw);
  if (reparsed.root === null) {
    throw new OcPathEditError("unresolved");
  }
  return reparsed;
}

function resolveEditTarget(root: JsoncValue, segments: readonly string[]): JsoncEditTarget | null {
  const match = resolveJsoncValueOcPath(root, segments);
  return (
    match && {
      path: match.path,
      value: match.kind === "object-entry" ? match.node.value : match.node,
    }
  );
}

function jsoncValueToJson(value: JsoncValue, guardPath: string): unknown {
  if (value.kind === "null") {
    return null;
  }
  if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") {
    guardSentinel(value.value, guardPath);
    return value.value;
  }
  if (value.kind === "array") {
    return value.items.map((item, index) => jsoncValueToJson(item, `${guardPath}/${index}`));
  }
  return Object.fromEntries(
    value.entries.map((entry) => [
      entry.key,
      jsoncValueToJson(entry.value, `${guardPath}/${entry.key}`),
    ]),
  );
}
