// OC Path module implements emit behavior.
import { emitWithMode, type EmitOptions } from "../emit-mode.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { YamlAst } from "./ast.js";

export function emitYaml(ast: YamlAst, opts: EmitOptions = {}): string {
  return emitWithMode(ast, opts, (guardPath) => {
    const rendered = ast.doc.toString();
    if (rendered.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[rendered]`);
    }
    return rendered;
  });
}
