import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function utf8JsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function streamDeltaByteLength(chunk: Record<string, unknown>): number | undefined {
  const type = chunk.type;
  if (
    (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") &&
    typeof chunk.delta === "string"
  ) {
    return Buffer.byteLength(chunk.delta, "utf8");
  }
  return undefined;
}

const OMIT_JSON_PROPERTY = Symbol("omitJsonProperty");
const FALLBACK_JSON_PROPERTY = Symbol("fallbackJsonProperty");
type PlainJsonPropertyValue = string | typeof OMIT_JSON_PROPERTY | typeof FALLBACK_JSON_PROPERTY;

function plainJsonPropertyValue(value: unknown): PlainJsonPropertyValue {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value) ?? "null";
    case "undefined":
    case "symbol":
      return OMIT_JSON_PROPERTY;
    case "object":
      return value === null ? "null" : FALLBACK_JSON_PROPERTY;
    case "bigint":
    case "function":
      return FALLBACK_JSON_PROPERTY;
  }
  return FALLBACK_JSON_PROPERTY;
}

function utf8JsonPlainDataObjectByteLengthWithoutOwnKey(
  object: Record<string, unknown>,
  excludedKey: string,
): number | undefined {
  // Keep the fast path limited to data values that JSON can encode without
  // invoking getters, nested serializers, or prototype hooks.
  let bytes = 2;
  let hasEntry = false;
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (typeof key === "symbol") {
      return undefined;
    }
    if (key === excludedKey) {
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    const propertyValue = plainJsonPropertyValue(descriptor.value);
    if (propertyValue === OMIT_JSON_PROPERTY) {
      continue;
    }
    if (propertyValue === FALLBACK_JSON_PROPERTY) {
      return undefined;
    }
    if (hasEntry) {
      bytes += 1;
    }
    bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
    bytes += Buffer.byteLength(propertyValue, "utf8");
    hasEntry = true;
  }
  return bytes;
}

function utf8JsonObjectRestByteLengthWithoutOwnKey(
  object: Record<string, unknown>,
  excludedKey: string,
): number | undefined {
  const snapshotlessObject: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(object)) {
    if (key === excludedKey) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    Object.defineProperty(snapshotlessObject, key, {
      configurable: true,
      enumerable: true,
      value: Reflect.get(object, key),
      writable: true,
    });
  }
  return utf8JsonByteLength(snapshotlessObject);
}

function utf8JsonObjectByteLengthWithoutOwnKey(
  object: Record<string, unknown>,
  excludedKey: string,
): number | undefined {
  const plainDataBytes = utf8JsonPlainDataObjectByteLengthWithoutOwnKey(object, excludedKey);
  if (plainDataBytes !== undefined) {
    return plainDataBytes;
  }
  return utf8JsonObjectRestByteLengthWithoutOwnKey(object, excludedKey);
}

function responseStreamChunkByteLengthUnchecked(chunk: unknown): number | undefined {
  if (!isRecord(chunk)) {
    return utf8JsonByteLength(chunk);
  }
  const deltaBytes = streamDeltaByteLength(chunk);
  if (deltaBytes !== undefined) {
    return deltaBytes;
  }
  if (!("partial" in chunk)) {
    return utf8JsonByteLength(chunk);
  }
  return utf8JsonObjectByteLengthWithoutOwnKey(chunk, "partial");
}

export function responseStreamChunkByteLength(chunk: unknown): number | undefined {
  try {
    return responseStreamChunkByteLengthUnchecked(chunk);
  } catch {
    return undefined;
  }
}
