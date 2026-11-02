// RFC 8785 JSON Canonicalization Scheme for the JSON subset used by signed statements.

/** JSON values that can be canonicalized. `undefined` object members are omitted, as in JSON.stringify. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Serializes a value per RFC 8785.
 *
 * ECMAScript's JSON.stringify already produces the RFC 8785 forms for numbers and
 * strings, so the work here is key ordering (UTF-16 code units, which is the
 * default Array#sort order) and rejecting values JSON cannot carry.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JCS: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE_RE.test(value)) {
      throw new Error("JCS: lone surrogate in string");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => canonicalize(item)).join(",")}]`;
  }
  // Plain object: members sorted by key, undefined members dropped.
  const record = value as { readonly [key: string]: JsonValue | undefined };
  const members: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    const member = record[key];
    if (member !== undefined) {
      members.push(`${canonicalize(key)}:${canonicalize(member)}`);
    }
  }
  return `{${members.join(",")}}`;
}
