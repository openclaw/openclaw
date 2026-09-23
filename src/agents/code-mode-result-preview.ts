import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { createJsonPrefixFitter } from "./code-mode-json-fit.js";

export type CodeModeResultReference = {
  id: string;
  bytes: number;
  count: number;
  shape: string;
  preview: string;
  previewTruncated: boolean;
};

const MAX_REFERENCE_BYTES = 768;
const MAX_VISITS = 128;
const MAX_DEPTH = 5;
const MAX_KEYS = 16;
const MAX_ARRAYS = 8;

function sampleIndices(length: number): number[] {
  return length ? [...new Set([0, Math.floor(length / 2), length - 1])] : [];
}

function kind(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function previewText(value: string, maxBytes: number): string {
  const prefix = truncateUtf8Prefix(value, maxBytes);
  return prefix === value ? value : `${prefix}…`;
}

function sampleShape(value: unknown): string {
  if (!isRecord(value)) {
    return kind(value);
  }
  const fields: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    // Values have crossed JSON normalization; these are own data properties.
    fields.push(`${JSON.stringify(previewText(key, 40))}:${kind(value[key])}`);
    if (fields.length === 6) {
      break;
    }
  }
  return `{${fields.join(",")}}`;
}

function sampledValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return previewText(value, 48);
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  if (depth >= 2) {
    return Array.isArray(value) ? `[array: ${value.length} items]` : "[object]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 2).map((item) => sampledValue(item, depth + 1));
  }
  const sample: Record<string, unknown> = Object.create(null);
  let keys = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      sample[previewText(key, 40)] = sampledValue(value[key], depth + 1);
      if (++keys === 6) {
        break;
      }
    }
  }
  return sample;
}

function envelopeFields(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidates: Array<[string, unknown]> = [];
  let examined = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (++examined > MAX_KEYS) {
      break;
    }
    const item = value[key];
    if (
      (item === null || typeof item !== "object") &&
      (typeof item !== "string" || item.length <= 48)
    ) {
      candidates.push([previewText(key, 40), item]);
    }
  }
  // Compact scalar flags/counts provide envelope context without hiding the arrays.
  candidates.sort((a, b) => Number(typeof a[1] === "string") - Number(typeof b[1] === "string"));
  const fields: Record<string, unknown> = Object.create(null);
  let kept = 0;
  for (const [key, item] of candidates) {
    fields[key] = item;
    if (jsonUtf8Bytes(fields) > 96) {
      delete fields[key];
    } else if (++kept === 4) {
      break;
    }
  }
  return kept ? fields : undefined;
}

function inspectArrays(value: unknown) {
  const queue = [{ value, path: "$", depth: 0 }];
  const arrays: Array<{ path: string; value: unknown[] }> = [];
  let limited = false;
  for (const entry of queue) {
    if (!isRecord(entry.value) && !Array.isArray(entry.value)) {
      continue;
    }
    if (Array.isArray(entry.value)) {
      arrays.push({ path: entry.path, value: entry.value });
      arrays.sort(
        (a, b) =>
          b.value.length - a.value.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      if (arrays.length > MAX_ARRAYS) {
        arrays.pop();
        limited = true;
      }
    }
    if (entry.depth === MAX_DEPTH) {
      limited = true;
      continue;
    }
    const enqueue = (child: unknown, path: string) => {
      if (queue.length >= MAX_VISITS || Buffer.byteLength(path) > 192) {
        limited = true;
      } else {
        queue.push({ value: child, path, depth: entry.depth + 1 });
      }
    };
    if (Array.isArray(entry.value)) {
      const indices = sampleIndices(entry.value.length);
      limited ||= indices.length < entry.value.length;
      for (const childIndex of indices) {
        enqueue(entry.value[childIndex], `${entry.path}[${childIndex}]`);
      }
      continue;
    }
    let keys = 0;
    for (const key in entry.value) {
      if (!Object.hasOwn(entry.value, key)) {
        continue;
      }
      if (++keys > MAX_KEYS) {
        limited = true;
        break;
      }
      if (key.length > 192) {
        limited = true;
        continue;
      }
      const segment = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
        ? `.${key}`
        : `[${JSON.stringify(key)}]`;
      enqueue(entry.value[key], entry.path + segment);
    }
  }
  return { arrays, limited };
}

/** Keep the usable identity intact; only descriptive samples may shrink. */
export function fitCodeModeResultReference(
  reference: CodeModeResultReference,
  maxBytes: number,
): CodeModeResultReference | undefined {
  if (jsonUtf8Bytes(reference) <= maxBytes) {
    return reference;
  }
  const minimal = { ...reference, shape: "", preview: "", previewTruncated: true };
  const remaining = maxBytes - jsonUtf8Bytes(minimal);
  if (remaining < 0) {
    return undefined;
  }
  const shapeBytes = 2 + Math.floor(remaining / 3);
  const shape = createJsonPrefixFitter(reference.shape, shapeBytes, () => 0)(shapeBytes);
  const previewBytes = 2 + remaining - (jsonUtf8Bytes(shape) - 2);
  const preview = createJsonPrefixFitter(reference.preview, previewBytes, () => 0)(previewBytes);
  return { ...minimal, shape, preview };
}

export function createCodeModeResultReference(
  id: string,
  json: string,
  value: unknown,
): CodeModeResultReference {
  const { arrays, limited } = inspectArrays(value);
  const samples = arrays.map(({ path, value: items }) => {
    const indices = sampleIndices(items.length);
    const shapes = [...new Set(indices.map((index) => sampleShape(items[index])))];
    return {
      path,
      count: items.length,
      observed: `sampled ${indices.length}/${items.length}${shapes.length > 1 ? " heterogeneous" : ""}: ${shapes.join(" | ")}`,
      items: indices.map((index) => ({ index, value: sampledValue(items[index]) })),
    };
  });
  const bytes = Buffer.byteLength(json, "utf8");
  const reference = {
    id,
    bytes,
    count: Array.isArray(value)
      ? value.length
      : value !== null && typeof value === "object"
        ? Object.keys(value).length
        : 1,
    shape: `${limited ? "limited traversal; " : ""}${
      samples.length
        ? samples
            .map((sample) => `${sample.path}: ${sample.count} items, ${sample.observed}`)
            .join("; ")
        : sampleShape(value)
    }`,
    preview:
      bytes <= 256
        ? json
        : JSON.stringify(
            samples.length
              ? {
                  sampled: true,
                  traversalLimited: limited,
                  fields: envelopeFields(value),
                  arrays: samples.map(({ observed: _observed, ...sample }) => sample),
                }
              : { sampled: true, traversalLimited: limited, value: sampledValue(value) },
          ),
    previewTruncated: bytes > 256,
  };
  const fitted = fitCodeModeResultReference(reference, MAX_REFERENCE_BYTES);
  if (!fitted) {
    throw new Error("Code Mode reference identity exceeds its descriptor allowance.");
  }
  return fitted;
}
