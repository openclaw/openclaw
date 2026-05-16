import { describe, expect, it } from "vitest";
import { __testing } from "./cli.js";

describe("voice-call CLI gateway fallback", () => {
  it("treats abnormal local gateway closes as standalone-runtime fallback candidates", () => {
    expect(
      __testing.isGatewayUnavailableForLocalFallback(
        new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
      ),
    ).toBe(true);
  });
});

describe("voice-call CLI numeric options", () => {
  it("parses bounded integer options", () => {
    expect(__testing.parseBoundedIntegerOption(undefined, 25, { name: "--since", min: 0 })).toBe(
      25,
    );
    expect(__testing.parseBoundedIntegerOption("12.9", 25, { name: "--since", min: 0 })).toBe(12);
    expect(__testing.parseBoundedIntegerOption("-10", 25, { name: "--since", min: 0 })).toBe(0);
    expect(__testing.parseBoundedIntegerOption("0", 200, { name: "--last", min: 1 })).toBe(1);
  });

  it("rejects invalid numeric option values", () => {
    expect(() =>
      __testing.parseBoundedIntegerOption("later", 25, { name: "--since", min: 0 }),
    ).toThrow("--since must be a finite number");
    expect(() =>
      __testing.parseBoundedIntegerOption(Number.NaN, 250, { name: "--poll", min: 50 }),
    ).toThrow("--poll must be a finite number");
  });
});
