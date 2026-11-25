import { POS_FIRST, POS_LAST } from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";

export function pickJsonlLine(ast: JsonlAst, addr: string): JsonlLine | null {
  const index = pickJsonlLineIndex(ast, addr);
  if (index === -1) {
    return null;
  }
  return ast.lines[index] ?? null;
}

export function pickJsonlLineIndex(ast: JsonlAst, addr: string): number {
  if (addr === POS_FIRST) {
    return ast.lines.findIndex((line) => line.kind === "value");
  }
  if (addr === POS_LAST) {
    return ast.lines.findLastIndex((line) => line?.kind === "value");
  }
  const match = /^L(\d+)$/.exec(addr);
  if (match === null || match[1] === undefined) {
    return -1;
  }
  const target = Number(match[1]);
  return ast.lines.findIndex((line) => line.line === target);
}

/**
 * A recursive wildcard in the line slot can also consume JSONC keys inside the
 * line. Only the line address belongs in the section slot; move the rest into
 * the value slots, merging so emitted paths keep at most three slots.
 */
export function keepOnlyLineAddressInSection(runs: string[][]): string[][] {
  const lineRun = runs[0];
  if (lineRun === undefined || lineRun.length <= 1) {
    return runs;
  }
  const rest = runs.slice(1);
  const [head = [], ...tail] = rest.length < 2 ? [[], ...rest] : rest;
  return [lineRun.slice(0, 1), [...lineRun.slice(1), ...head], ...tail];
}
