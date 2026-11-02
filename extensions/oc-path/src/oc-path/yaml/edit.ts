import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Node,
  type Scalar,
  type ScalarTag,
} from "yaml";
import { OcPathEditError } from "../edit-error.js";
import type { OcPath } from "../oc-path.js";
import { formatOcPath } from "../oc-path.js";
import { guardSentinel } from "../sentinel.js";
import { sourceLineEnding } from "../source.js";
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
  // Object-valued keys cannot retain their identity when the document is cloned.
  if (segments.some((segment) => segment !== null && typeof segment === "object")) {
    throw new OcPathEditError("unresolved");
  }
  if (!ast.doc.hasIn(segments)) {
    throw new OcPathEditError("unresolved");
  }

  const { doc: cloned, lineCounter, numericSources } = cloneDoc(ast);
  const previous = cloned.getIn(segments, true);
  if (isScalar(previous)) {
    numericSources.delete(previous);
  }
  cloned.setIn(segments, newValue);
  return { kind: "yaml", raw: stringifyDoc(cloned, ast.raw), doc: cloned, lineCounter };
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
  const { doc: cloned, lineCounter } = cloneDoc(ast);

  const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
  if (parent === undefined || parent === null) {
    throw new OcPathEditError("unresolved");
  }

  if (isMap(parent)) {
    if (typeof marker !== "object" || marker.kind !== "keyed") {
      throw new OcPathEditError("unresolved");
    }
    guardSentinel(marker.key, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);
    // Match the same key spelling used by path resolution, including native scalar keys.
    if (
      parent.items.some(
        (pair) => String(isScalar(pair.key) ? pair.key.value : pair.key) === marker.key,
      )
    ) {
      throw new OcPathEditError("unresolved");
    }
    cloned.setIn([...segments, marker.key], newValue);
    return { kind: "yaml", raw: stringifyDoc(cloned, ast.raw), doc: cloned, lineCounter };
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
    return { kind: "yaml", raw: stringifyDoc(cloned, ast.raw), doc: cloned, lineCounter };
  }

  throw new OcPathEditError("unresolved");
}

function stringifyDoc(doc: Document.Parsed, raw: string): string {
  return doc.toString().replace(/\n/g, sourceLineEnding(raw));
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

function cloneDoc(ast: YamlAst): {
  doc: Document.Parsed;
  lineCounter: LineCounter;
  numericSources: WeakMap<Scalar, { value: number; source: string }>;
} {
  const lineCounter = new LineCounter();
  const numericSources = new WeakMap<Scalar, { value: number; source: string }>();
  const cloned = parseDocument(ast.raw, {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
    customTags: (tags) =>
      tags.map((tag) => {
        if (
          typeof tag === "string" ||
          tag.collection !== undefined ||
          !["tag:yaml.org,2002:int", "tag:yaml.org,2002:float"].includes(tag.tag)
        ) {
          return tag;
        }
        const stringify = tag.stringify;
        if (typeof stringify !== "function") {
          return tag;
        }
        const preserveSource: NonNullable<ScalarTag["stringify"]> = (item, ...args) => {
          const original = numericSources.get(item);
          return original && Object.is(item.value, original.value)
            ? original.source
            : stringify(item, ...args);
        };
        return { ...tag, stringify: preserveSource };
      }),
  });
  // Retain exact numeric tokens without changing the parser's Number read contract.
  visit(cloned, {
    Scalar(_key, node) {
      if (typeof node.value === "number" && node.source !== undefined) {
        numericSources.set(node, { value: node.value, source: node.source });
      }
    },
  });
  return { doc: cloned, lineCounter, numericSources };
}
