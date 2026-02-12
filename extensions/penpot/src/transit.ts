/**
 * Transit JSON encoding/decoding for PenPot RPC.
 *
 * PenPot uses Cognitect's Transit format with custom handlers:
 * - "u" tag for UUIDs
 * - "m" tag for instants (Date)
 * - Keywords prefixed with "~:"
 *
 * @see penpot/common/src/app/common/transit.cljc
 */

import transit from "transit-js";

// ============================================================================
// Keyword helper
// ============================================================================

/**
 * Create a Transit keyword. In PenPot's wire format, keywords are
 * strings prefixed with "~:" (e.g., "~:rect" for the Clojure keyword :rect).
 */
export function kw(name: string): transit.Keyword {
  return transit.keyword(name);
}

// ============================================================================
// Encoder
// ============================================================================

/**
 * Encode a JavaScript value to Transit JSON string.
 *
 * Handles the conversion of plain JS objects/maps into Transit format
 * compatible with PenPot's Clojure backend. Keys that are strings get
 * converted to Transit keywords automatically.
 */
export function transitEncode(value: unknown): string {
  const w = transit.writer("json");
  return w.write(prepareForTransit(value));
}

/**
 * Recursively prepare a JS value for Transit encoding.
 * Converts plain objects to Transit maps with keyword keys.
 */
function prepareForTransit(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(prepareForTransit);
  }

  if (value instanceof Date) {
    return value;
  }

  if (transit.isKeyword(value) || transit.isUUID(value)) {
    return value;
  }

  if (typeof value === "object") {
    const entries: unknown[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      entries.push(kw(k));
      entries.push(prepareForTransit(v));
    }
    return transit.map(entries);
  }

  return value;
}

// ============================================================================
// Decoder
// ============================================================================

/**
 * Decode a Transit JSON string from PenPot into plain JS objects.
 *
 * Transit maps become plain objects, keywords become strings,
 * UUIDs become strings.
 */
export function transitDecode(data: string): unknown {
  const r = transit.reader("json", {
    handlers: {
      u: (rep: unknown) => String(rep),
    },
  });
  const parsed = r.read(data);
  return transitToJs(parsed);
}

/**
 * Recursively convert decoded Transit values to plain JS.
 */
function transitToJs(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (transit.isKeyword(value)) {
    return (value as transit.Keyword)._name;
  }

  if (transit.isUUID(value)) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(transitToJs);
  }

  // Handle transit-js tagged values (custom types like "shape", "matrix")
  if (value && typeof value === "object" && "tag" in value && "rep" in value) {
    return transitToJs((value as { tag: string; rep: unknown }).rep);
  }

  // Transit maps have forEach, keys, get methods
  if (
    value &&
    typeof value === "object" &&
    "forEach" in value &&
    typeof (value as transit.TransitMap).forEach === "function"
  ) {
    const result: Record<string, unknown> = {};
    (value as transit.TransitMap).forEach((v: unknown, k: unknown) => {
      const key = transit.isKeyword(k) ? (k as transit.Keyword)._name : String(k);
      result[key] = transitToJs(v);
    });
    return result;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}
