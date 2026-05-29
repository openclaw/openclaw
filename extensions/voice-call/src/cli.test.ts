import { describe, expect, it } from "vitest";
import { testing } from "./cli.js";

describe("voice-call CLI gateway fallback", () => {
  it("treats abnormal local gateway closes as standalone-runtime fallback candidates", () => {
    expect(
      testing.isGatewayUnavailableForLocalFallback(
        new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
      ),
    ).toBe(true);
  });
});

describe("parseVoiceCallIntOption", () => {
  it("parses decimal integer option values", () => {
    expect(testing.parseVoiceCallIntOption("250", "--poll", { min: 50 })).toBe(250);
    expect(testing.parseVoiceCallIntOption(" 25 ", "--since")).toBe(25);
  });

  it("rejects non-decimal JavaScript numeric syntax", () => {
    expect(() => testing.parseVoiceCallIntOption("0x10", "--last")).toThrow(
      "Invalid numeric value for --last: 0x10",
    );
    expect(() => testing.parseVoiceCallIntOption("1e3", "--last")).toThrow(
      "Invalid numeric value for --last: 1e3",
    );
  });
});
