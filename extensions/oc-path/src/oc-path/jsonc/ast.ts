/** The root JSONC AST. `raw` round-trips byte-identical via emit. */
export interface JsoncAst {
  readonly kind: "jsonc";
  readonly raw: string;
  /** Parsed value tree, or `null` if the file is empty / unparseable. */
  readonly root: JsoncValue | null;
}

/**
 * `line` is the 1-based line where the value's literal token starts
 * (the `{`, `[`, opening `"`, or first digit). The parser always sets
 * it; synthetic constructions (mutations, fixtures) may omit it and
 * consumers fall back to 1 / parent line. Optional rather than
 * required so test fixtures and externally-constructed values stay
 * concise.
 */
export type JsoncValue =
  | { readonly kind: "object"; readonly entries: readonly JsoncEntry[]; readonly line?: number }
  | { readonly kind: "array"; readonly items: readonly JsoncValue[]; readonly line?: number }
  | { readonly kind: "string"; readonly value: string; readonly line?: number }
  | { readonly kind: "number"; readonly value: number; readonly line?: number }
  | { readonly kind: "boolean"; readonly value: boolean; readonly line?: number }
  | { readonly kind: "null"; readonly line?: number };

/** Object key/value entry. Keys are unquoted; quoting happens at emit. */
export interface JsoncEntry {
  readonly key: string;
  readonly value: JsoncValue;
  /** 1-based line number of the key. */
  readonly line: number;
}
