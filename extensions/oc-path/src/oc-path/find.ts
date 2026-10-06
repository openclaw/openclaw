/**
 * `findOcPaths` — multi-match verb. `*` matches one sub-segment;
 * `**` matches zero or more (recursive). Returns concrete OcPaths
 * preserving the input pattern's slot shape, so each result is
 * pipeable into `resolveOcPath` / `setOcPath`.
 *
 * @module @openclaw/oc-path/find
 */

import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isMap, isScalar, isSeq, type Node, type Pair } from "yaml";
import type { AstBlock, AstItem, MdAst } from "./ast.js";
import type { JsoncValue } from "./jsonc/ast.js";
import { resolveJsoncPositionalSegment } from "./jsonc/resolve-value.js";
import type { JsonlAst, JsonlLine } from "./jsonl/ast.js";
import { pickJsonlLine } from "./jsonl/line.js";
import type { OcPath, PredicateSpec } from "./oc-path.js";
import {
  MAX_TRAVERSAL_DEPTH,
  OcPathError,
  WILDCARD_RECURSIVE,
  WILDCARD_SINGLE,
  evaluatePredicate,
  isOrdinalSeg,
  isPositionalSeg,
  isPredicateSeg,
  isUnionSeg,
  parseArrayIndexSegment,
  parseOrdinalSeg,
  parsePredicateSeg,
  parseUnionSeg,
  quoteSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "./oc-path.js";
import type { OcAst, OcMatch } from "./universal.js";
import { resolveOcPath } from "./universal.js";
import { resolveYamlPositionalSegment } from "./yaml/resolve.js";

// ---------- Public types ---------------------------------------------------

/** A find result: a concrete (wildcard-free) path plus its match info. */
interface OcPathMatch {
  readonly path: OcPath;
  readonly match: OcMatch;
}

type Slot = "section" | "item" | "field";
interface SlotSub {
  readonly slot: Slot;
  readonly value: string;
}

type OnMatch = (subs: readonly SlotSub[]) => void;

// ---------- Public verb ----------------------------------------------------

export function findOcPaths(ast: OcAst, pattern: OcPath): readonly OcPathMatch[] {
  const subs = patternSubs(pattern);
  // Fast-path: no expansion needed — pure literals just resolve.
  const needsExpansion = subs.some(
    (s) =>
      s.value === WILDCARD_SINGLE ||
      s.value === WILDCARD_RECURSIVE ||
      isPositionalSeg(s.value) ||
      isUnionSeg(s.value) ||
      isPredicateSeg(s.value),
  );
  if (!needsExpansion) {
    const m = resolveOcPath(ast, pattern);
    return m === null ? [] : [{ path: pattern, match: m }];
  }

  const concretePaths: OcPath[] = [];
  const onMatch: OnMatch = (slotSubs) => {
    concretePaths.push(repackSlotSubs(pattern, slotSubs));
  };
  switch (ast.kind) {
    case "jsonc":
      if (ast.root !== null) {
        walkJsonc(ast.root, subs, 0, [], onMatch);
      }
      break;
    case "jsonl":
      walkJsonl(ast, subs, 0, [], onMatch);
      break;
    case "md":
      walkMd({ kind: "root", ast }, subs, 0, [], onMatch);
      break;
    case "yaml":
      if (ast.doc.contents !== null) {
        walkYaml(ast.doc.contents, subs, 0, [], onMatch);
      }
      break;
  }

  const out: OcPathMatch[] = [];
  for (const concrete of concretePaths) {
    const m = resolveOcPath(ast, concrete);
    if (m !== null) {
      out.push({ path: concrete, match: m });
    }
  }
  return out;
}

// ---------- Pattern unpacking ---------------------------------------------

function patternSubs(pattern: OcPath): readonly SlotSub[] {
  const out: SlotSub[] = [];
  // Bracket-aware split so dots inside `[k=1.0]` or `{a.b,c}` aren't
  // treated as sub-segment delimiters.
  for (const slot of ["section", "item", "field"] as const) {
    const value = pattern[slot];
    if (value !== undefined) {
      for (const sub of splitRespectingBrackets(value, ".")) {
        out.push({ slot, value: sub });
      }
    }
  }
  return out;
}

function repackSlotSubs(pattern: OcPath, slotSubs: readonly SlotSub[]): OcPath {
  const values: Record<Slot, string[]> = { section: [], item: [], field: [] };
  for (const { slot, value } of slotSubs) {
    values[slot].push(value);
  }
  return {
    file: pattern.file,
    ...(values.section.length > 0 ? { section: values.section.join(".") } : {}),
    ...(values.item.length > 0 ? { item: values.item.join(".") } : {}),
    ...(values.field.length > 0 ? { field: values.field.join(".") } : {}),
    ...(pattern.session !== undefined ? { session: pattern.session } : {}),
  };
}

// ---------- Shared dispatch ----------------------------------------------

// Per-kind ops the dispatcher uses to drive recursion. Each kind's
// walker fills these in; the dispatcher handles every segment shape.
interface WalkOps<T, Child = T> {
  enumerate(
    node: T,
    matches?: (child: Child) => boolean,
  ): Iterable<{ keySub: string; child: Child }>;
  lookup(node: T, key: string): { keySub: string; child: Child } | null;
  positional(node: T, seg: string): { keySub: string; child: Child } | null;
  predicate(node: T, pred: PredicateSpec): Iterable<{ keySub: string; child: Child }>;
  walk(
    node: T | Child,
    subs: readonly SlotSub[],
    i: number,
    walked: readonly SlotSub[],
    onMatch: OnMatch,
  ): void;
}

function checkDepth(walked: readonly SlotSub[]): void {
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a pathological pattern`,
      "",
      "OC_PATH_DEPTH_EXCEEDED",
    );
  }
}

function dispatchSeg<T, Child>(
  node: T,
  ops: WalkOps<T, Child>,
  subs: readonly SlotSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  const cur = expectDefined(subs[i], "dispatch index checked by walker");

  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {
      return;
    }
    for (const alt of alts) {
      const altSubs = subs.slice();
      altSubs[i] = { slot: cur.slot, value: alt };
      ops.walk(node, altSubs, i, walked, onMatch);
    }
    return;
  }

  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred === null) {
      return;
    }
    for (const m of ops.predicate(node, pred)) {
      ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
    }
    return;
  }

  if (cur.value === WILDCARD_RECURSIVE) {
    // `**` — descend with `**` consumed (i+1) AND retained (i) so
    // deeper structures still match. Emit if no subs remain.
    if (i + 1 >= subs.length) {
      onMatch(walked);
    }
    for (const m of ops.enumerate(node)) {
      const nextWalked: readonly SlotSub[] = [...walked, { slot: cur.slot, value: m.keySub }];
      ops.walk(m.child, subs, i + 1, nextWalked, onMatch);
      ops.walk(m.child, subs, i, nextWalked, onMatch);
    }
    return;
  }

  if (cur.value === WILDCARD_SINGLE) {
    for (const m of ops.enumerate(node)) {
      ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
    }
    return;
  }

  const m = isPositionalSeg(cur.value)
    ? ops.positional(node, cur.value)
    : ops.lookup(node, cur.value);
  if (m === null) {
    return;
  }
  ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
}

// ---------- JSONC walker ---------------------------------------------------

function walkJsonc(
  node: JsoncValue,
  subs: readonly SlotSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  dispatchSeg(node, jsoncOps, subs, i, walked, onMatch);
}

const jsoncOps: WalkOps<JsoncValue> = {
  *enumerate(node, matches) {
    if (node.kind === "object") {
      for (const e of node.entries) {
        if (!matches || matches(e.value)) {
          yield { keySub: quoteSeg(e.key), child: e.value };
        }
      }
    } else if (node.kind === "array") {
      for (const [idx, child] of node.items.entries()) {
        if (!matches || matches(child)) {
          yield { keySub: String(idx), child };
        }
      }
    }
  },
  lookup(node, key) {
    if (node.kind === "object") {
      // Entry keys are unquoted in the AST; strip quotes from a quoted
      // path key so the walker matches the resolver's behavior.
      const lookupKey = unquoteSeg(key);
      const e = node.entries.find((entry) => entry.key === lookupKey);
      return e === undefined ? null : { keySub: key, child: e.value };
    }
    if (node.kind === "array") {
      const idx = parseArrayIndexSegment(key, node.items.length);
      if (idx === null) {
        return null;
      }
      return {
        keySub: key,
        child: expectDefined(node.items[idx], "parsed JSONC array index is in bounds"),
      };
    }
    return null;
  },
  positional(node, seg) {
    const concrete = resolveJsoncPositionalSegment(node, seg);
    if (concrete === null) {
      return null;
    }
    const match = jsoncOps.lookup(node, concrete);
    if (match === null || node.kind !== "object") {
      return match;
    }
    return { keySub: quoteSeg(concrete), child: match.child };
  },
  *predicate(node, pred) {
    yield* jsoncOps.enumerate(node, (child) =>
      evaluatePredicate(jsoncChildFieldText(child, pred.key), pred),
    );
  },
  walk: walkJsonc,
};

// ---------- JSONL walker ---------------------------------------------------

// First slot is a line address; subsequent slots descend into its JSONC value.
function walkJsonl(
  ast: JsonlAst,
  subs: readonly SlotSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  if (walked.length === 0) {
    dispatchSeg(ast, jsonlOps, subs, i, walked, onMatch);
  }
}

const jsonlOps: WalkOps<JsonlAst, JsonlLine> = {
  *enumerate(ast, matches) {
    for (const l of ast.lines) {
      if (l.kind === "value" && (!matches || matches(l))) {
        yield { keySub: `L${l.line}`, child: l };
      }
    }
  },
  lookup(ast, key) {
    const line = pickJsonlLine(ast, key);
    if (line === null) {
      return null;
    }
    const concreteAddr = line.kind === "value" ? `L${line.line}` : key;
    return { keySub: concreteAddr, child: line };
  },
  positional(ast, seg) {
    return jsonlOps.lookup(ast, seg);
  },
  *predicate(ast, pred) {
    yield* jsonlOps.enumerate(
      ast,
      (line) =>
        line.kind === "value" && evaluatePredicate(topLevelLeafText(line.value, pred.key), pred),
    );
  },
  // Union alternatives revisit the file; consumed line slots descend into JSONC.
  walk(child, subs, i, walked, onMatch) {
    if (child.kind === "jsonl") {
      walkJsonl(child, subs, i, walked, onMatch);
      return;
    }
    if (i >= subs.length) {
      onMatch(walked);
      return;
    }
    if (child.kind !== "value") {
      return;
    }
    walkJsonc(child.value, subs, i, walked, onMatch);
  },
};

function topLevelLeafText(value: JsoncValue, key: string): string | null {
  if (value.kind !== "object") {
    return null;
  }
  const entry = value.entries.find((e) => e.key === key);
  if (entry === undefined) {
    return null;
  }
  const v = entry.value;
  if (v.kind === "string") {
    return v.value;
  }
  if (v.kind === "number" || v.kind === "boolean") {
    return String(v.value);
  }
  return null;
}

// ---------- YAML walker ----------------------------------------------------

function walkYaml(
  node: Node,
  subs: readonly SlotSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  dispatchSeg(node, yamlOps, subs, i, walked, onMatch);
}

const yamlOps: WalkOps<Node> = {
  *enumerate(node, matches) {
    if (isMap(node)) {
      for (const p of (node as { items: readonly Pair[] }).items) {
        const k = isScalar(p.key) ? p.key.value : p.key;
        if (p.value !== null && (!matches || matches(p.value as Node))) {
          yield { keySub: quoteSeg(String(k)), child: p.value as Node };
        }
      }
    } else if (isSeq(node)) {
      for (let idx = 0; idx < node.items.length; idx++) {
        const child = node.items[idx];
        if (child !== null && (!matches || matches(child as Node))) {
          yield { keySub: String(idx), child: child as Node };
        }
      }
    }
  },
  lookup(node, key) {
    if (isMap(node)) {
      const lookupKey = unquoteSeg(key);
      const pair = (node as { items: readonly Pair[] }).items.find((p) => {
        const k = isScalar(p.key) ? p.key.value : p.key;
        return String(k) === lookupKey;
      });
      return pair?.value === undefined || pair.value === null
        ? null
        : { keySub: key, child: pair.value as Node };
    }
    if (isSeq(node)) {
      const idx = parseArrayIndexSegment(key, node.items.length);
      if (idx === null) {
        return null;
      }
      const child = node.items[idx];
      if (child === null) {
        return null;
      }
      return { keySub: key, child: child as Node };
    }
    return null;
  },
  positional(node, seg) {
    const concrete = resolveYamlPositionalSegment(node, seg);
    return concrete === null ? null : yamlOps.lookup(node, concrete);
  },
  *predicate(node, pred) {
    yield* yamlOps.enumerate(node, (child) =>
      evaluatePredicate(yamlChildFieldText(child, pred.key), pred),
    );
  },
  walk: walkYaml,
};

function yamlChildFieldText(node: Node, key: string): string | null {
  if (!isMap(node)) {
    return null;
  }
  const pair = (node as { items: readonly Pair[] }).items.find((p) => {
    const k = isScalar(p.key) ? p.key.value : p.key;
    return String(k) === key;
  });
  if (pair === undefined || pair.value === null) {
    return null;
  }
  return yamlScalarToText(pair.value);
}

function yamlScalarToText(value: unknown): string | null {
  if (!isScalar(value)) {
    return null;
  }
  const scalar = value.value;
  if (typeof scalar === "string") {
    return scalar;
  }
  if (typeof scalar === "number" || typeof scalar === "boolean") {
    return String(scalar);
  }
  if (scalar === null) {
    return "null";
  }
  if (typeof scalar === "bigint" || typeof scalar === "symbol") {
    return scalar.toString();
  }
  if (scalar instanceof Date) {
    return scalar.toISOString();
  }
  return JSON.stringify(scalar) ?? null;
}

// ---------- Markdown walker -----------------------------------------------

type MdLevel =
  | { readonly kind: "root"; readonly ast: MdAst }
  | { readonly kind: "block"; readonly block: AstBlock }
  | { readonly kind: "item"; readonly item: AstItem };

function walkMd(
  level: MdLevel,
  subs: readonly SlotSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = expectDefined(subs[i], "Markdown walk index checked above");

  // Frontmatter sentinel short-circuits regular dispatch.
  if (level.kind === "root" && walked.length === 0 && cur.value === "[frontmatter]") {
    const next = subs[i + 1];
    if (next === undefined) {
      onMatch([{ slot: cur.slot, value: cur.value }]);
      return;
    }
    if (next.value === WILDCARD_SINGLE || next.value === WILDCARD_RECURSIVE) {
      for (const fm of level.ast.frontmatter) {
        onMatch([
          { slot: cur.slot, value: cur.value },
          { slot: next.slot, value: fm.key },
        ]);
      }
      return;
    }
    const fmKey = unquoteSeg(next.value);
    const entry = level.ast.frontmatter.find((e) => e.key === fmKey);
    if (entry === undefined) {
      return;
    }
    onMatch([
      { slot: cur.slot, value: cur.value },
      { slot: next.slot, value: next.value },
    ]);
    return;
  }

  // Item-level field slot is terminal — descending would loop.
  if (level.kind === "item") {
    walkMdItemField(level.item, cur, walked, onMatch);
    return;
  }

  dispatchSeg(level, mdOps, subs, i, walked, onMatch);
}

function walkMdItemField(
  item: AstItem,
  cur: SlotSub,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  if (item.kv === undefined) {
    return;
  }
  const key = item.kv.key;
  const emit = (value: string): void => {
    onMatch([...walked, { slot: cur.slot, value }]);
  };
  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {
      return;
    }
    for (const alt of alts) {
      if (alt.toLowerCase() === key.toLowerCase()) {
        emit(key);
      }
    }
    return;
  }
  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred !== null && mdItemMatchesPredicate(item, pred)) {
      emit(key);
    }
    return;
  }
  if (cur.value === WILDCARD_SINGLE || cur.value === WILDCARD_RECURSIVE) {
    emit(key);
    return;
  }
  if (key.toLowerCase() === cur.value.toLowerCase()) {
    emit(cur.value);
  }
}

function blockSlugCounts(items: readonly AstItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
  }
  return counts;
}

// `mdOps` only handles root / block levels. Item-level dispatch is
// terminal and runs inline in `walkMd` (see `walkMdItemField`).
const mdOps: WalkOps<MdLevel> = {
  *enumerate(level, matches) {
    if (level.kind === "root") {
      for (const block of level.ast.blocks) {
        const child = { kind: "block" as const, block };
        if (!matches || matches(child)) {
          yield { keySub: block.slug, child };
        }
      }
      return;
    }
    if (level.kind === "block") {
      // Disambiguate duplicate slugs via `#N` ordinal so each emitted
      // path round-trips through resolveOcPath to its own item.
      const counts = blockSlugCounts(level.block.items);
      for (const [idx, item] of level.block.items.entries()) {
        const child = { kind: "item" as const, item };
        if (!matches || matches(child)) {
          const seg = (counts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug;
          yield { keySub: seg, child };
        }
      }
    }
  },
  lookup(level, key) {
    if (level.kind === "root") {
      const target = key.toLowerCase();
      const block = level.ast.blocks.find((b) => b.slug === target);
      return block === undefined ? null : { keySub: key, child: { kind: "block", block } };
    }
    if (level.kind === "block") {
      // Ordinal `#N` short-circuits slug lookup.
      if (isOrdinalSeg(key)) {
        const n = parseOrdinalSeg(key);
        if (n === null || n < 0 || n >= level.block.items.length) {
          return null;
        }
        return {
          keySub: key,
          child: {
            kind: "item",
            item: expectDefined(level.block.items[n], "validated Markdown ordinal is in bounds"),
          },
        };
      }
      const target = key.toLowerCase();
      const item = level.block.items.find((it) => it.slug === target);
      return item === undefined ? null : { keySub: key, child: { kind: "item", item } };
    }
    return null;
  },
  positional(level, seg) {
    if (level.kind !== "block") {
      return null;
    }
    const concrete = resolvePositionalSeg(seg, {
      indexable: true,
      size: level.block.items.length,
    });
    if (concrete === null) {
      return null;
    }
    // Preserve the positional token in keySub so the resolver
    // re-evaluates positionally on round-trip.
    const item = expectDefined(
      level.block.items[Number(concrete)],
      "resolved Markdown position is in bounds",
    );
    return { keySub: seg, child: { kind: "item", item } };
  },
  *predicate(level, pred) {
    yield* mdOps.enumerate(level, (child) =>
      child.kind === "block"
        ? child.block.items.some((item) => mdItemMatchesPredicate(item, pred))
        : child.kind === "item" && mdItemMatchesPredicate(child.item, pred),
    );
  },
  walk: walkMd,
};

function mdItemMatchesPredicate(item: AstItem, pred: PredicateSpec): boolean {
  if (item.kv === undefined) {
    return false;
  }
  if (item.kv.key.toLowerCase() !== pred.key.toLowerCase()) {
    return false;
  }
  return evaluatePredicate(item.kv.value, pred);
}

function jsoncChildFieldText(node: JsoncValue, key: string): string | null {
  if (node.kind !== "object") {
    return null;
  }
  const e = node.entries.find((entry) => entry.key === key);
  if (e === undefined) {
    return null;
  }
  const v = e.value;
  if (v.kind === "string") {
    return v.value;
  }
  if (v.kind === "number" || v.kind === "boolean") {
    return String(v.value);
  }
  if (v.kind === "null") {
    return "null";
  }
  return null;
}
