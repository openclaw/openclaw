/**
 * Emit an AST back to bytes.
 *
 * **Two modes**:
 *
 *   1. **Round-trip** — the AST hasn't been mutated since `parseMd`
 *      produced it. Returns `ast.raw` verbatim. Byte-identical.
 *
 *   2. **Mutation-aware** — the AST has been modified (frontmatter
 *      entry edited, item kv.value changed, block reordered). Returns
 *      a freshly-rendered representation. **Not** byte-identical to a
 *      hypothetical "perfect" rewrite — we render canonical forms
 *      (LF endings, single space after `:` in frontmatter, etc.).
 *      Callers needing byte-fidelity for partial edits should patch
 *      `raw` directly instead of mutating the AST.
 *
 * In both modes, every emitted leaf flows through `guardSentinel` so a
 * `__OPENCLAW_REDACTED__` literal anywhere in the output throws
 * `OcEmitSentinelError`. This is the substrate guard: callers can't
 * accidentally write a redacted view to disk through this emitter.
 *
 * @module @openclaw/oc-path/emit
 */

import type { MdAst } from "./ast.js";
import { emitWithMode, type EmitOptions } from "./emit-mode.js";
import { formatFrontmatterValue } from "./frontmatter-format.js";
import { guardSentinel } from "./sentinel.js";

/**
 * Emit the AST. In render mode, throws `OcEmitSentinelError` if any
 * leaf string matches `REDACTED_SENTINEL`. In round-trip mode, echoes
 * `ast.raw` verbatim (does not scan unless caller opts in via
 * `acceptPreExistingSentinel: false`).
 */
export function emitMd(ast: MdAst, opts: EmitOptions = {}): string {
  return emitWithMode(ast, opts, (guardPath) => {
    for (const fm of ast.frontmatter) {
      guardSentinel(fm.value, `${guardPath}/[frontmatter]/${fm.key}`);
    }
    if (ast.preamble.length > 0) {
      guardSentinel(ast.preamble, `${guardPath}/[preamble]`);
    }
    for (const block of ast.blocks) {
      if (block.bodyText.length > 0) {
        guardSentinel(block.bodyText, `${guardPath}/${block.slug}/[body]`);
        for (const item of block.items) {
          if (item.kv) {
            guardSentinel(item.kv.value, `${guardPath}/${block.slug}/${item.slug}/${item.kv.key}`);
          }
        }
      }
    }
    return rebuildMdRaw(ast).raw;
  });
}

// Editing guards new values separately, preserving unrelated pre-existing sentinel text.
export function rebuildMdRaw(ast: MdAst): MdAst {
  const parts: string[] = [];
  if (ast.frontmatter.length > 0) {
    parts.push("---");
    for (const fm of ast.frontmatter) {
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push("---");
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(ast.preamble);
  }
  for (const block of ast.blocks) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {
      parts.push(block.bodyText);
    }
  }
  return { ...ast, raw: parts.join("\n") };
}
