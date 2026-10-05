/**
 * Stable stringify helper.
 * Serializes arbitrary values with deterministic key ordering and explicit
 * handling for dates, errors, binary data, collections, bigint, non-finite numbers, and cycles.
 */

type StableStringNormalizer = (value: string) => string;
type StableStringWriter = (chunk: string) => void;

const preserveString = (value: string) => value;

/** Deterministically stringifies values, optionally normalizing strings before key ordering. */
export function stableStringify(
  value: unknown,
  normalizeString: StableStringNormalizer = preserveString,
): string {
  return stringifyStableValue(value, new WeakSet(), normalizeString);
}

/** Writes the same deterministic text without retaining completed container strings. */
export function writeStableStringify(
  value: unknown,
  write: StableStringWriter,
  normalizeString: StableStringNormalizer = preserveString,
): void {
  write(stringifyStableValue(value, new WeakSet(), normalizeString, write));
}

function stringifyStableValue(
  value: unknown,
  stack: WeakSet<object>,
  normalizeString: StableStringNormalizer,
  write?: StableStringWriter,
): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeString(value));
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (stack.has(value)) {
    return JSON.stringify("[Circular]");
  }

  stack.add(value);
  try {
    return stringifyObjectValue(value, stack, normalizeString, write);
  } finally {
    stack.delete(value);
  }
}

function stringifyObjectValue(
  value: object,
  stack: WeakSet<object>,
  normalizeString: StableStringNormalizer,
  write?: StableStringWriter,
): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "null"
      : JSON.stringify(normalizeString(value.toISOString()));
  }
  if (value instanceof RegExp) {
    return JSON.stringify(normalizeString(value.toString()));
  }
  if (value instanceof Error) {
    return stringifyStableValue(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      stack,
      normalizeString,
      write,
    );
  }
  if (value instanceof Uint8Array) {
    return stringifyStableValue(
      {
        type: "Uint8Array",
        data: encodeBase64(value),
      },
      stack,
      normalizeString,
      write,
    );
  }
  if (Array.isArray(value)) {
    if (write) {
      write("[");
      let separator = "";
      for (const entry of value) {
        write(separator);
        write(stringifyStableValue(entry, stack, normalizeString, write));
        separator = ",";
      }
      write("]");
      return "";
    }
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stringifyStableValue(entry, stack, normalizeString));
    }
    return `[${serializedEntries.join(",")}]`;
  }
  if (value instanceof Set) {
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stringifyStableValue(entry, stack, normalizeString));
    }
    serializedEntries.sort(compareStableStrings);
    return `[${serializedEntries.join(",")}]`;
  }
  if (value instanceof Map) {
    const entries: Array<{ keySerialized: string; valueSerialized: string }> = [];
    for (const [k, v] of value.entries()) {
      entries.push({
        keySerialized: stringifyStableValue(k, stack, normalizeString),
        valueSerialized: stringifyStableValue(v, stack, normalizeString),
      });
    }
    entries.sort(
      (left, right) =>
        compareStableStrings(left.keySerialized, right.keySerialized) ||
        compareStableStrings(left.valueSerialized, right.valueSerialized),
    );
    const serializedPairs = entries.map(
      ({ keySerialized, valueSerialized }) => `[${keySerialized},${valueSerialized}]`,
    );
    return `[${serializedPairs.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const fields: Array<string | { key: string; normalizedKey: string }> =
    normalizeString === preserveString
      ? keys.sort() // oxlint-disable-line unicorn/no-array-sort -- keys is a private array.
      : keys
          .map((key) => ({ key, normalizedKey: normalizeString(key) }))
          // oxlint-disable-next-line unicorn/no-array-sort -- map creates a private entry array.
          .sort((left, right) => {
            const normalizedOrder = compareStableStrings(left.normalizedKey, right.normalizedKey);
            // Distinct source keys can normalize alike; preserve deterministic ordering without loss.
            return normalizedOrder || compareStableStrings(left.key, right.key);
          });
  write?.("{");
  const serializedFields: string[] = normalizeString === preserveString ? keys : [];
  let separator = "";
  let fieldIndex = 0;
  for (const field of fields) {
    const key = typeof field === "string" ? field : field.key;
    const prefix = `${JSON.stringify(typeof field === "string" ? field : field.normalizedKey)}:`;
    if (write) {
      write(`${separator}${prefix}`);
      write(stringifyStableValue(record[key], stack, normalizeString, write));
      separator = ",";
    } else {
      serializedFields[fieldIndex++] =
        `${prefix}${stringifyStableValue(record[key], stack, normalizeString)}`;
    }
  }
  if (write) {
    write("}");
    return "";
  }
  return `{${serializedFields.join(",")}}`;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
