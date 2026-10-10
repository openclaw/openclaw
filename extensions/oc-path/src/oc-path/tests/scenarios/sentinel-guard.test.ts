// OC Path tests cover sentinel guard plugin behavior.
import { describe, expect, it } from "vitest";
import { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "../../sentinel.js";

describe("sentinel-guard", () => {
  it("guardSentinel passes non-string types", () => {
    expect(() => guardSentinel(42, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel(null, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel(undefined, "oc://X.md")).not.toThrow();
    expect(() => guardSentinel({}, "oc://X.md")).not.toThrow();
  });

  it("guardSentinel throws on substring matches (sentinel embedded in larger string)", () => {
    // Substring scan — the sentinel anywhere in the value is a leak,
    // not just exact equality. A hostile caller smuggling
    // `prefix__OPENCLAW_REDACTED__suffix` would have bypassed the old
    // equality check; substring scan closes the gap.
    expect(() => guardSentinel(`prefix${REDACTED_SENTINEL}suffix`, "oc://X.md")).toThrow(
      OcEmitSentinelError,
    );
  });
});
