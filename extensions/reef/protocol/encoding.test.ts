import { describe, expect, it } from "vitest";
import { base64, base64url, fromBase64, fromBase64url } from "./encoding.js";

describe("Reef binary encoding", () => {
  it.each([
    [[], "", ""],
    [[102], "Zg==", "Zg"],
    [[102, 111], "Zm8=", "Zm8"],
    [[102, 111, 111], "Zm9v", "Zm9v"],
    [[251, 255, 255], "+///", "-___"],
  ] as const)("preserves canonical wire bytes %j", (bytes, encoded, urlEncoded) => {
    const value = Uint8Array.from(bytes);
    expect(base64(value)).toBe(encoded);
    expect(base64url(value)).toBe(urlEncoded);
    expect(fromBase64(encoded)).toEqual(value);
    expect(fromBase64url(urlEncoded)).toEqual(value);
  });

  it.each(["Zg", "Zg=", "Zg===", "Zg==\n", "-___"])(
    "rejects invalid standard base64 syntax %j",
    (value) => expect(() => fromBase64(value)).toThrow("invalid base64"),
  );

  it.each(["Zh==", "Zm9="])("rejects nonzero standard padding bits %j", (value) => {
    expect(() => fromBase64(value)).toThrow("non-canonical base64");
  });

  it.each(["A", "Zg=", "Zg\n", "+///"])("rejects invalid base64url syntax %j", (value) => {
    expect(() => fromBase64url(value)).toThrow("invalid base64url");
  });

  it.each(["Zh", "Zm9"])("rejects nonzero base64url padding bits %j", (value) => {
    expect(() => fromBase64url(value)).toThrow("invalid base64url padding");
  });
});
