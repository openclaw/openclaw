import { describe, expect, it } from "vitest";
import { resolveMatrixLocation } from "./location.js";

describe("resolveMatrixLocation", () => {
  const eventType = "m.room.message";

  function makeContent(geoUri: string) {
    return {
      msgtype: "m.location",
      body: "My location",
      geo_uri: geoUri,
    } as any;
  }

  it("parses a standard geo URI", () => {
    const result = resolveMatrixLocation({
      eventType,
      content: makeContent("geo:37.786971,-122.399677"),
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("37.786971");
  });

  it("parses a geo URI with accuracy parameter", () => {
    const result = resolveMatrixLocation({
      eventType,
      content: makeContent("geo:37.786971,-122.399677;u=65"),
    });
    expect(result).not.toBeNull();
  });

  it("does not throw on malformed percent-encoded parameter values", () => {
    const result = resolveMatrixLocation({
      eventType,
      content: makeContent("geo:37.786971,-122.399677;desc=%ZZinvalid"),
    });
    expect(result).not.toBeNull();
  });

  it("returns null for empty geo URI", () => {
    const result = resolveMatrixLocation({
      eventType,
      content: makeContent(""),
    });
    expect(result).toBeNull();
  });

  it("returns null for invalid coordinates", () => {
    const result = resolveMatrixLocation({
      eventType,
      content: makeContent("geo:abc,def"),
    });
    expect(result).toBeNull();
  });
});
