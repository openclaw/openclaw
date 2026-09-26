// OC Path module implements resolve behavior.
import { isMap, isScalar, isSeq, type Node, type Pair } from "yaml";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  parseArrayIndexSegment,
  resolvePositionalSeg,
  splitOcPathSlots,
} from "../oc-path.js";
import type { YamlAst } from "./ast.js";

type YamlOcPathMatch =
  | { readonly kind: "root"; readonly node: YamlAst }
  | { readonly kind: "scalar"; readonly value: unknown; readonly path: readonly string[] }
  | {
      readonly kind: "map";
      readonly path: readonly string[];
    }
  | {
      readonly kind: "seq";
      readonly path: readonly string[];
    }
  | {
      readonly kind: "pair";
      readonly key: string;
      readonly value: unknown;
      readonly path: readonly string[];
    };

export function resolveYamlOcPath(ast: YamlAst, path: OcPath): YamlOcPathMatch | null {
  const segments = splitOcPathSlots(path.section, path.item, path.field);

  if (segments.length === 0) {
    return { kind: "root", node: ast };
  }

  const root = ast.doc.contents;
  if (root === null) {
    return null;
  }

  return walkNode(root, segments, 0, []);
}

function walkNode(
  node: Node | null,
  segments: readonly string[],
  i: number,
  walked: readonly string[],
): YamlOcPathMatch | null {
  if (node === null) {
    return null;
  }
  let seg = segments[i];

  if (seg === undefined) {
    if (isMap(node)) {
      return { kind: "map", path: walked };
    }
    if (isSeq(node)) {
      return { kind: "seq", path: walked };
    }
    if (isScalar(node)) {
      return { kind: "scalar", value: node.value, path: walked };
    }
    return null;
  }
  if (seg.length === 0) {
    return null;
  }

  if (isPositionalSeg(seg)) {
    const concrete = resolveYamlPositionalSegment(node, seg);
    if (concrete !== null) {
      seg = concrete;
    }
  }

  if (isMap(node)) {
    const pair = (node as { items: Pair[] }).items.find((p) => {
      const k = isScalar(p.key) ? p.key.value : p.key;
      return String(k) === seg;
    });
    if (pair === undefined) {
      return null;
    }
    const childWalked = [...walked, seg];
    if (i === segments.length - 1) {
      const child = pair.value;
      if (isScalar(child)) {
        return {
          kind: "pair",
          key: seg,
          value: child.value,
          path: childWalked,
        };
      }
      return walkNode(child as Node, segments, i + 1, childWalked);
    }
    return walkNode(pair.value as Node, segments, i + 1, childWalked);
  }

  if (isSeq(node)) {
    const idx = parseArrayIndexSegment(seg, node.items.length);
    if (idx === null) {
      return null;
    }
    const child = node.items[idx];
    return walkNode(child as Node, segments, i + 1, [...walked, seg]);
  }

  return null;
}

export function resolveYamlPositionalSegment(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const pairs = (node as { items: Pair[] }).items;
    const keys = pairs.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    const items = (node as { items: Node[] }).items;
    return resolvePositionalSeg(seg, { indexable: true, size: items.length });
  }
  return null;
}
