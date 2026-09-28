/**
 * Stable stringify helper.
 * Serializes arbitrary values with deterministic key ordering and explicit
 * handling for errors, binary data, bigint, non-finite numbers, and cycles.
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
  const record = value as Record<string, unknown>;
  if (normalizeString === preserveString) {
    // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys creates a private array.
    const fields = Object.keys(record).sort();
    if (write) {
      write("{");
      let separator = "";
      for (const key of fields) {
        write(`${separator}${JSON.stringify(key)}:`);
        write(stringifyStableValue(record[key], stack, normalizeString, write));
        separator = ",";
      }
      write("}");
      return "";
    }
    let fieldIndex = 0;
    for (const key of fields) {
      fields[fieldIndex++] =
        `${JSON.stringify(key)}:${stringifyStableValue(record[key], stack, normalizeString)}`;
    }
    return `{${fields.join(",")}}`;
  }
  const entries = Object.keys(record)
    .map((key) => ({ key, normalizedKey: normalizeString(key) }))
    // oxlint-disable-next-line unicorn/no-array-sort -- map creates a private entry array.
    .sort((left, right) => {
      const normalizedOrder = compareStableStrings(left.normalizedKey, right.normalizedKey);
      // Distinct source keys can normalize alike; preserve deterministic ordering without loss.
      return normalizedOrder || compareStableStrings(left.key, right.key);
    });
  const serializedFields: string[] = [];
  if (write) {
    write("{");
    let separator = "";
    for (const { key, normalizedKey } of entries) {
      write(`${separator}${JSON.stringify(normalizedKey)}:`);
      write(stringifyStableValue(record[key], stack, normalizeString, write));
      separator = ",";
    }
    write("}");
    return "";
  }
  for (const { key, normalizedKey } of entries) {
    serializedFields.push(
      `${JSON.stringify(normalizedKey)}:${stringifyStableValue(record[key], stack, normalizeString)}`,
    );
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
