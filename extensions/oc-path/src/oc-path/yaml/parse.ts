import { LineCounter, parseDocument } from "yaml";
import type { YamlAst } from "./ast.js";

export function parseYaml(raw: string): YamlAst {
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  return { kind: "yaml", raw, doc, lineCounter };
}
