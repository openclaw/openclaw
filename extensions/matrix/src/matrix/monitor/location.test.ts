import { describe, expect, it } from "vitest";
import type { LocationMessageEventContent } from "../sdk.js";
import { resolveMatrixLocation } from "./location.js";
import { EventType } from "./types.js";

function createLocationContent(geoUri: string): LocationMessageEventContent {
  return {
    body: "Shared pin",
    geo_uri: geoUri,
    msgtype: EventType.Location,
  };
}

describe("resolveMatrixLocation", () => {
  it("resolves geo URI accuracy parameters", () => {
    const payload = resolveMatrixLocation({
      eventType: EventType.Location,
      content: createLocationContent("geo:45.5,9.2;u=12%2E5"),
    });

    expect(payload?.text).toContain("45.500000, 9.200000");
    expect(payload?.context).toMatchObject({
      LocationAccuracy: 12.5,
      LocationCaption: "Shared pin",
      LocationIsLive: false,
      LocationLat: 45.5,
      LocationLon: 9.2,
      LocationSource: "pin",
    });
  });

  it("ignores malformed encoded geo URI parameters", () => {
    expect(
      resolveMatrixLocation({
        eventType: EventType.Location,
        content: createLocationContent("geo:45.5,9.2;u=%"),
      }),
    ).toBeNull();
  });
});
