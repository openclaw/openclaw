import { describe, expect, it } from "vitest";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
  parseEmbedding,
} from "./embedding-vector.js";

describe("persistent memory embedding format", () => {
  it("uses portable little-endian binary64 bytes and honors sliced buffer offsets", () => {
    const values = [1, -2.5, Number.MIN_VALUE, -0];
    const bytes = encodeMemoryEmbedding(values);
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "000000000000f03f00000000000004c001000000000000000000000000000080",
    );
    const framed = new Uint8Array(bytes.length + 3);
    framed.set(bytes, 1);
    expect(decodeMemoryEmbedding(framed.subarray(1, 1 + bytes.length))).toEqual(values);
    expect(decodeMemoryEmbedding(encodeMemoryEmbedding([]))).toEqual([]);
  });

  it("preserves finite precision that the vec0 float32 accelerator cannot retain", () => {
    const values = [1 + Number.EPSILON, Number.MAX_VALUE, 1e-300, Math.PI];
    expect(decodeMemoryEmbedding(encodeMemoryEmbedding(values))).toEqual(values);
    expect(() => encodeMemoryEmbedding([Infinity])).toThrow("finite numeric coordinates");
  });

  it("leaves the published JSON parser contract intact for legacy consumers", () => {
    expect(parseEmbedding("[0.1,0.2]")).toEqual([0.1, 0.2]);
    expect(parseEmbedding("[1,null]")).toEqual([1, null]);
    expect(parseEmbedding("invalid")).toEqual([]);
    expect(parseEmbedding("{}")).toEqual([]);
  });
});
