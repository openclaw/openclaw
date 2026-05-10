/**
 * Document-level parse / emit helpers.
 *
 * `parseOcPath` parses an `oc://` address. These helpers parse and
 * emit the document that address points into, using the filename to
 * choose the concrete markdown / jsonc / jsonl codec.
 *
 * @module @openclaw/oc-path/document
 */

import type { Diagnostic } from "./ast.js";
import type { OcKind } from "./dispatch.js";
import { inferKind } from "./dispatch.js";
import type { EmitOptions } from "./emit.js";
import { emitMd } from "./emit.js";
import type { JsoncEmitOptions } from "./jsonc/emit.js";
import { emitJsonc } from "./jsonc/emit.js";
import { parseJsonc } from "./jsonc/parse.js";
import type { JsonlEmitOptions } from "./jsonl/emit.js";
import { emitJsonl } from "./jsonl/emit.js";
import { parseJsonl } from "./jsonl/parse.js";
import { parseMd } from "./parse.js";
import type { OcAst } from "./universal.js";

export interface ParseOcDocumentOptions {
  readonly fileName: string;
  readonly kind?: OcKind;
}

export interface ParseOcDocumentResult {
  readonly ast: OcAst;
  readonly diagnostics: readonly Diagnostic[];
  readonly kind: OcKind;
}

export type EmitOcDocumentOptions = EmitOptions & JsoncEmitOptions & JsonlEmitOptions;

export class OcDocumentKindError extends Error {
  constructor(fileName: string) {
    super(`Could not infer oc-path document kind from '${fileName}'.`);
    this.name = "OcDocumentKindError";
  }
}

export function parseOcDocument(
  raw: string,
  options: ParseOcDocumentOptions,
): ParseOcDocumentResult {
  const kind = options.kind ?? inferKind(options.fileName);
  if (kind === null) {
    throw new OcDocumentKindError(options.fileName);
  }

  switch (kind) {
    case "md":
      return { ...parseMd(raw), kind };
    case "jsonc":
      return { ...parseJsonc(raw), kind };
    case "jsonl":
      return { ...parseJsonl(raw), kind };
  }
}

export function emitOcDocument(ast: OcAst, options: EmitOcDocumentOptions = {}): string {
  switch (ast.kind) {
    case "md":
      return emitMd(ast, options);
    case "jsonc":
      return emitJsonc(ast, options);
    case "jsonl":
      return emitJsonl(ast, options);
  }
}
