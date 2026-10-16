import { Document, isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { OcPathEditError } from "../edit-error.js";
import type { OcPath } from "../oc-path.js";
import { formatOcPath } from "../oc-path.js";
import { guardSentinel } from "../sentinel.js";
import type { YamlAst } from "./ast.js";
import { resolveYamlOcPath } from "./resolve.js";

export function setYamlOcPath(ast: YamlAst, path: OcPath, newValue: unknown): YamlAst {
  if (ast.doc.errors.length > 0) {
    throw new OcPathEditError("parse-error");
  }
  if (ast.doc.contents === null) {
    throw new OcPathEditError("no-root");
  }
  guardYamlSentinel(newValue, formatOcPath(path));

  // Keep read/write addressing aligned for positional tokens and YAML key coercion.
  const match = resolveYamlOcPath(ast, path);
  if (match === null || match.kind === "root") {
    throw new OcPathEditError("unresolved");
  }
  const segments = match.path;
  if (!ast.doc.hasIn(segments)) {
    throw new OcPathEditError("unresolved");
  }

  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
  cloned.setIn(segments, newValue);
  return { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter };
}

export function insertYamlOcPath(
  ast: YamlAst,
  parentPath: OcPath,
  marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number },
  newValue: unknown,
): YamlAst {
  if (ast.doc.errors.length > 0) {
    throw new OcPathEditError("parse-error");
  }
  if (ast.doc.contents === null) {
    throw new OcPathEditError("no-root");
  }
  guardYamlSentinel(newValue, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);

  const match = resolveYamlOcPath(ast, parentPath);
  if (match === null) {
    throw new OcPathEditError("unresolved");
  }
  const segments = match.kind === "root" ? [] : match.path;
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);

  const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
  if (parent === undefined || parent === null) {
    throw new OcPathEditError("unresolved");
  }

  if (isMap(parent)) {
    if (typeof marker !== "object" || marker.kind !== "keyed") {
      throw new OcPathEditError("unresolved");
    }
    guardSentinel(marker.key, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);
    if (cloned.hasIn([...segments, marker.key])) {
      throw new OcPathEditError("unresolved");
    }
    cloned.setIn([...segments, marker.key], newValue);
    return { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter };
  }

  if (isSeq(parent)) {
    if (typeof marker === "object" && marker.kind === "keyed") {
      throw new OcPathEditError("unresolved");
    }
    if (marker === "+") {
      cloned.addIn(segments, newValue);
    } else if (typeof marker === "object" && marker.kind === "indexed") {
      const idx = Math.min(marker.index, parent.items.length);
      parent.items.splice(idx, 0, cloned.createNode(newValue) as Node);
    }
    return { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter };
  }

  throw new OcPathEditError("unresolved");
}

function formatInsertionMarker(
  marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number },
): string {
  if (marker === "+") {
    return "+";
  }
  return marker.kind === "keyed" ? `+${marker.key}` : `+${marker.index}`;
}

function guardYamlSentinel(value: unknown, ocPath: string): void {
  guardSentinel(value, ocPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => guardYamlSentinel(item, `${ocPath}/${index}`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      guardSentinel(key, `${ocPath}/${key}`);
      guardYamlSentinel(child, `${ocPath}/${key}`);
    }
  }
}

function cloneDoc(doc: Document.Parsed): { doc: Document.Parsed; lineCounter: LineCounter } {
  const lineCounter = new LineCounter();
  const cloned = parseDocument(doc.toString(), {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  return { doc: cloned, lineCounter };
}
