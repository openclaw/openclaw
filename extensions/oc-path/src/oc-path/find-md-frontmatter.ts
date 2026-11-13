import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { MdAst } from "./ast.js";
import type { SlotSub, WalkContext } from "./find-types.js";
import {
  WILDCARD_RECURSIVE,
  WILDCARD_SINGLE,
  isUnionSeg,
  parseUnionSeg,
  quoteSeg,
  unquoteSeg,
} from "./oc-path.js";

/** Match terminal keys after a root Markdown frontmatter sentinel. */
export function walkMdFrontmatter(
  ast: MdAst,
  subs: readonly SlotSub[],
  i: number,
  context: WalkContext,
): void {
  const cur = expectDefined(subs[i], "Frontmatter sentinel index checked by walker");
  const visitKey = JSON.stringify(["frontmatter", subs.slice(i)]);
  const visited = context.visited.get(ast) ?? new Set<string>();
  if (visited.has(visitKey)) {
    return;
  }
  context.visited.set(ast, visited.add(visitKey));
  // Frontmatter keys are leaves; recursive wildcards may consume zero segments.
  let key: SlotSub | undefined;
  for (let j = i + 1; j < subs.length; j++) {
    const sub = expectDefined(subs[j], "Frontmatter key index checked above");
    if (isUnionSeg(sub.value)) {
      for (const alt of parseUnionSeg(sub.value) ?? []) {
        const altSubs = subs.slice();
        altSubs[j] = { slot: sub.slot, value: alt };
        walkMdFrontmatter(ast, altSubs, i, context);
      }
      return;
    }
    if (sub.value === WILDCARD_RECURSIVE) {
      continue;
    }
    if (key) {
      return;
    }
    key = sub;
  }
  const next = key ?? subs[i + 1];
  if (next === undefined) {
    context.onMatch([{ slot: cur.slot, value: cur.value }]);
    return;
  }
  const wildcard = next.value === WILDCARD_SINGLE || next.value === WILDCARD_RECURSIVE;
  const fmKey = unquoteSeg(next.value);
  for (const fm of ast.frontmatter) {
    if (!wildcard && fm.key !== fmKey) {
      continue;
    }
    context.onMatch([
      { slot: cur.slot, value: cur.value },
      { slot: next.slot, value: quoteSeg(fm.key) },
    ]);
  }
}
