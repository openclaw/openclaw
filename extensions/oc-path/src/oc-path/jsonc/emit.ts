/**
 * Emit a `JsoncAst` to bytes.
 *
 * Round-trip (default) echoes `ast.raw` verbatim — preserves comments
 * and formatting. Sentinel guard fires only in render mode by default;
 * round-trip trusts parsed bytes so a workspace file legitimately
 * containing the sentinel literal isn't a global emit DoS. Callers
 * that need pre-existing detection opt in via
 * `acceptPreExistingSentinel: false`.
 *
 * @module @openclaw/oc-path/jsonc/emit
 */

import { emitWithMode, type EmitOptions } from "../emit-mode.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsoncAst, JsoncValue } from "./ast.js";

export function emitJsonc(ast: JsoncAst, opts: EmitOptions = {}): string {
  return emitWithMode(ast, opts, (guardPath) => {
    // Render mode loses comments; walks leaves for caller-injected sentinel.
    if (ast.root === null) {
      return "";
    }
    return renderJsoncValue(ast.root, guardPath, " ");
  });
}

export function renderJsoncValue(
  value: JsoncValue,
  guardPath: string,
  space: "" | " ",
  walked: readonly string[] = [],
): string {
  switch (value.kind) {
    case "object": {
      const parts = value.entries.map(
        (e) =>
          `${JSON.stringify(e.key)}:${space}${renderJsoncValue(e.value, guardPath, space, [...walked, e.key])}`,
      );
      return `{${space}${parts.join(`,${space}`)}${space}}`;
    }
    case "array": {
      const parts = value.items.map((v, i) =>
        renderJsoncValue(v, guardPath, space, [...walked, String(i)]),
      );
      return `[${space}${parts.join(`,${space}`)}${space}]`;
    }
    case "string":
      // Substring match: embedded sentinel leaks marker bytes too.
      if (value.value.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
      }
      return JSON.stringify(value.value);
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "null":
      return "null";
  }
  return "";
}
