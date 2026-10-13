import { renderJsoncValue } from "../jsonc/emit.js";
import type { JsonlAst } from "./ast.js";

export function renderJsonl(ast: JsonlAst, fileName?: string): string {
  const guardPath = fileName ? `oc://${fileName}` : "oc://";
  const out: string[] = [];
  for (const line of ast.lines) {
    if (line.kind === "blank" || line.kind === "malformed") {
      out.push(line.raw);
      continue;
    }
    // Value lines always scan leaves so caller-injected sentinel is rejected.
    out.push(renderJsoncValue(line.value, `${guardPath}/L${line.line}`));
  }
  // Preserve the parsed convention when edits rebuild Windows-authored logs.
  return out.join(ast.lineEnding ?? "\n");
}
