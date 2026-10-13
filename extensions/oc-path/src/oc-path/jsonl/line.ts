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
