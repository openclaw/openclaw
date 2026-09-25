import { describe, expect, it } from "vitest";
import { decodeAcpxSessionRecordId } from "./session-file-names.js";

describe("decodeAcpxSessionRecordId", () => {
  it("decodes persisted record names", () => {
    expect(decodeAcpxSessionRecordId("legacy%20session.json")).toBe("legacy session");
  });

  it("returns undefined for malformed persisted record names", () => {
    expect(decodeAcpxSessionRecordId("bad%ZZ.json")).toBeUndefined();
  });
});
