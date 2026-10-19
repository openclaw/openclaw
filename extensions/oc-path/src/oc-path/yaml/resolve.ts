import { isMap, isScalar, isSeq, type Node } from "yaml";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  parseArrayIndexSegment,
  resolvePositionalSeg,
  splitOcPathSlots,
  unquoteSeg,
} from "../oc-path.js";
import type { YamlAst } from "./ast.js";

type YamlOcPathMatch =
  | { readonly kind: "root"; readonly node: YamlAst }
  | ({ readonly node: Node; readonly path: readonly unknown[] } & (
      | { readonly kind: "scalar"; readonly value: unknown }
      | { readonly kind: "map" }
      | { readonly kind: "seq" }
      | { readonly kind: "pair"; readonly key: string; readonly value: unknown }
    ));

export function resolveYamlOcPath(ast: YamlAst, path: OcPath): YamlOcPathMatch | null {
  const segments = splitOcPathSlots(path.section, path.item, path.field);

  if (segments.length === 0) {
    return { kind: "root", node: ast };
  }

  return walkNode(ast.doc.contents, segments, 0, []);
}

function walkNode(
  node: Node | null,
  segments: readonly string[],
  i: number,
  walked: readonly unknown[],
): YamlOcPathMatch | null {
  if (node === null) {
    return null;
  }
  const rawSeg = segments[i];

  if (rawSeg === undefined) {
    if (isMap(node)) {
      return { kind: "map", node, path: walked };
    }
    if (isSeq(node)) {
      return { kind: "seq", node, path: walked };
    }
    if (isScalar(node)) {
      return { kind: "scalar", node, value: node.value, path: walked };
    }
    return null;
  }
  let seg = unquoteSeg(rawSeg);
  if (seg.length === 0) {
    return null;
  }

  if (isPositionalSeg(rawSeg)) {
    const concrete = resolveYamlPositionalSegment(node, rawSeg);
    if (concrete !== null) {
      seg = concrete;
    }
  }

  if (isMap(node)) {
    const pair = node.items.find((p) => {
      const k = isScalar(p.key) ? p.key.value : p.key;
      return String(k) === seg;
    });
    if (pair === undefined) {
      return null;
    }
    const key = isScalar(pair.key) ? pair.key.value : seg;
    const childWalked = [...walked, key];
    if (i === segments.length - 1 && isScalar(pair.value)) {
      return {
        kind: "pair",
        node: pair.value,
        key: seg,
        value: pair.value.value,
        path: childWalked,
      };
    }
    return walkNode(pair.value as Node, segments, i + 1, childWalked);
  }

  if (isSeq(node)) {
    const idx = parseArrayIndexSegment(seg, node.items.length);
    if (idx === null) {
      return null;
    }
    const child = node.items[idx];
    return walkNode(child as Node, segments, i + 1, [...walked, idx]);
  }

  return null;
}

export function resolveYamlPositionalSegment(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}
