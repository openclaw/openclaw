/**
 * Minimal Prometheus Remote Write 1.0 protobuf encoder.
 *
 * Encodes `prometheus.WriteRequest` as defined in:
 *   https://github.com/prometheus/prometheus/blob/main/prompb/remote.proto
 *   https://github.com/prometheus/prometheus/blob/main/prompb/types.proto
 *
 * Wire format reference (proto3 binary):
 *   WriteRequest { repeated TimeSeries timeseries = 1; }
 *   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
 *   Label        { string name = 1; string value = 2; }
 *   Sample       { double value = 1; int64 timestamp = 2; }
 */

export type PromLabel = { name: string; value: string };
export type PromSample = { value: number; timestampMs: number };
export type PromTimeSeries = { labels: PromLabel[]; samples: PromSample[] };
export type PromWriteRequest = { timeseries: PromTimeSeries[] };

// --- Low-level protobuf encoding helpers ---

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function encodeVarint64(value: bigint): number[] {
  const bytes: number[] = [];
  let v = BigInt.asUintN(64, value);
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return bytes;
}

function encodeSignedVarint64(value: number): number[] {
  return encodeVarint64(BigInt(Math.trunc(value)));
}

const textEncoder = new TextEncoder();

function encodeString(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function encodeDouble(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  return new Uint8Array(buf);
}

function makeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

// Wire types
const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;

function encodeLengthDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
  const tag = makeTag(fieldNumber, LENGTH_DELIMITED);
  const len = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + len.length + data.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(data, tag.length + len.length);
  return result;
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// --- Message encoders ---

function encodeLabel(label: PromLabel): Uint8Array {
  const parts: Uint8Array[] = [];
  // field 1: string name
  if (label.name.length > 0) {
    const nameBytes = encodeString(label.name);
    parts.push(encodeLengthDelimited(1, nameBytes));
  }
  // field 2: string value
  if (label.value.length > 0) {
    const valueBytes = encodeString(label.value);
    parts.push(encodeLengthDelimited(2, valueBytes));
  }
  return concatBytes(parts);
}

function encodeSample(sample: PromSample): Uint8Array {
  const parts: Uint8Array[] = [];
  // field 1: double value (wire type 1 = fixed64)
  if (sample.value !== 0) {
    const tag = makeTag(1, FIXED64);
    const doubleBytes = encodeDouble(sample.value);
    const field = new Uint8Array(tag.length + 8);
    field.set(tag, 0);
    field.set(doubleBytes, tag.length);
    parts.push(field);
  }
  // field 2: int64 timestamp (wire type 0 = varint)
  if (sample.timestampMs !== 0) {
    const tag = makeTag(2, VARINT);
    const varint = encodeSignedVarint64(sample.timestampMs);
    const field = new Uint8Array(tag.length + varint.length);
    field.set(tag, 0);
    field.set(varint, tag.length);
    parts.push(field);
  }
  return concatBytes(parts);
}

function encodeTimeSeries(ts: PromTimeSeries): Uint8Array {
  const parts: Uint8Array[] = [];
  // field 1: repeated Label labels
  for (const label of ts.labels) {
    parts.push(encodeLengthDelimited(1, encodeLabel(label)));
  }
  // field 2: repeated Sample samples
  for (const sample of ts.samples) {
    parts.push(encodeLengthDelimited(2, encodeSample(sample)));
  }
  return concatBytes(parts);
}

/**
 * Encode a Prometheus Remote Write 1.0 `WriteRequest` into binary protobuf.
 */
export function encodeWriteRequest(req: PromWriteRequest): Uint8Array {
  const parts: Uint8Array[] = [];
  // field 1: repeated TimeSeries timeseries
  for (const ts of req.timeseries) {
    parts.push(encodeLengthDelimited(1, encodeTimeSeries(ts)));
  }
  return concatBytes(parts);
}
