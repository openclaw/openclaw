import {
  isPositionalSeg,
  parseArrayIndexSegment,
  resolvePositionalSeg,
  unquoteSeg,
} from "../oc-path.js";
import type { JsoncEntry, JsoncValue } from "./ast.js";

export function resolveJsoncValueOcPath(root: JsoncValue, segments: readonly string[]) {
  let current: JsoncValue = root;
  let lastEntry: JsoncEntry | null = null;
  // jsonc-parser edits distinguish object keys from array indices.
  const walked: (string | number)[] = [];

  for (const rawSeg of segments) {
    let seg = unquoteSeg(rawSeg);
    if (rawSeg.length === 0) {
      return null;
    }
    if (isPositionalSeg(rawSeg)) {
      const concrete = resolveJsoncPositionalSegment(current, rawSeg);
      if (concrete !== null) {
        seg = concrete;
      }
    }
    if (current.kind === "object") {
      // Duplicate keys: the last occurrence wins, matching JSON.parse/JSON5.
      const entry = current.entries.findLast((e) => e.key === seg);
      if (entry === undefined) {
        return null;
      }
      lastEntry = entry;
      walked.push(seg);
      current = entry.value;
      continue;
    }
    if (current.kind === "array") {
      const idx = parseArrayIndexSegment(seg, current.items.length);
      if (idx === null) {
        return null;
      }
      lastEntry = null;
      walked.push(idx);
      const item = current.items[idx];
      if (item === undefined) {
        return null;
      }
      current = item;
      continue;
    }
    return null;
  }

  if (lastEntry !== null && current === lastEntry.value) {
    return { kind: "object-entry", node: lastEntry, path: walked } as const;
  }
  return { kind: "value", node: current, path: walked } as const;
}

export function resolveJsoncPositionalSegment(node: JsoncValue, seg: string): string | null {
  if (node.kind === "object") {
    const keys = node.entries.map((e) => e.key);
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === "array") {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}
