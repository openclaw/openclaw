import { describe, expect, it } from "vitest";
import { isFillSentinel, findSentinelsInFields, WELL_KNOWN_FIELDS } from "./sentinel.js";

// ---------------------------------------------------------------------------
// isFillSentinel — well-known field values still detect as sentinels
// ---------------------------------------------------------------------------

describe("isFillSentinel — well-known field values", () => {
  it.each(WELL_KNOWN_FIELDS)('returns true for well-known field "%s"', (field) => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFillSentinel — open string union: any non-empty string field is accepted.
// Resolution is deferred to the fill-hook so forward-compat fields exposed via
// BuyerProfile.extras (e.g., a future "email" sentinel) flow through naturally.
// ---------------------------------------------------------------------------

describe("isFillSentinel — open string field (forward-compat)", () => {
  it("returns true for hypothetical 'email' field (forward-compat extras)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "email" })).toBe(true);
  });

  it("returns true for hypothetical 'phone' field (forward-compat extras)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "phone" })).toBe(true);
  });

  it("returns true for hypothetical 'shipping_line1' field (forward-compat extras)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "shipping_line1" })).toBe(true);
  });

  it("returns true for any non-empty string — resolution happens at fill time", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "anything_at_all" })).toBe(true);
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_zip" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFillSentinel — missing or wrong $paymentHandle
// ---------------------------------------------------------------------------

describe("isFillSentinel — $paymentHandle constraints", () => {
  it("returns false when $paymentHandle is missing", () => {
    expect(isFillSentinel({ field: "pan" })).toBe(false);
  });

  it("returns false when $paymentHandle is an empty string", () => {
    expect(isFillSentinel({ $paymentHandle: "", field: "pan" })).toBe(false);
  });

  it("returns false when $paymentHandle is a number", () => {
    expect(isFillSentinel({ $paymentHandle: 42, field: "pan" })).toBe(false);
  });

  it("returns false when $paymentHandle is null", () => {
    expect(isFillSentinel({ $paymentHandle: null, field: "pan" })).toBe(false);
  });

  it("returns false when $paymentHandle is an object", () => {
    expect(isFillSentinel({ $paymentHandle: {}, field: "pan" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFillSentinel — field constraints (only structural now: non-empty string)
// ---------------------------------------------------------------------------

describe("isFillSentinel — field structural constraints", () => {
  it("returns false when field is missing (partial sentinel)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc" })).toBe(false);
  });

  it("returns false for field value '' (empty string)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "" })).toBe(false);
  });

  it("returns false when field is a number", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: 1 })).toBe(false);
  });

  it("returns false when field is null", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: null })).toBe(false);
  });

  it("returns false when field is undefined", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: undefined })).toBe(false);
  });

  it("returns false when field is a boolean", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFillSentinel — non-object inputs
// ---------------------------------------------------------------------------

describe("isFillSentinel — non-object inputs", () => {
  it("returns false for null", () => {
    expect(isFillSentinel(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFillSentinel(undefined)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isFillSentinel("pan")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isFillSentinel(42)).toBe(false);
  });

  it("returns false for a boolean", () => {
    expect(isFillSentinel(true)).toBe(false);
  });

  it("returns false for an array", () => {
    expect(isFillSentinel(["pan"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findSentinelsInFields — mixed arrays
// ---------------------------------------------------------------------------

describe("findSentinelsInFields", () => {
  it("returns empty array when no fields", () => {
    expect(findSentinelsInFields([])).toEqual([]);
  });

  it("returns empty array when no sentinels", () => {
    const fields = [
      { ref: "card-number", type: "text", value: "not a sentinel" },
      { ref: "expiry", type: "text", value: "12/30" },
    ];
    expect(findSentinelsInFields(fields)).toEqual([]);
  });

  it("returns the sentinel index and value for a single sentinel", () => {
    const sentinel = { $paymentHandle: "h1", field: "pan" };
    const fields = [{ ref: "pan-field", type: "text", value: sentinel }];
    const result = findSentinelsInFields(fields);
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.sentinel).toBe(sentinel);
  });

  it("returns only the sentinel indices from a mixed array", () => {
    const sentinelA = { $paymentHandle: "h1", field: "pan" };
    const sentinelB = { $paymentHandle: "h1", field: "cvv" };
    const fields = [
      { ref: "name", type: "text", value: "John Doe" },
      { ref: "pan-field", type: "text", value: sentinelA },
      { ref: "exp-month", type: "text", value: "12" },
      { ref: "cvv-field", type: "password", value: sentinelB },
    ];
    const result = findSentinelsInFields(fields);
    expect(result).toHaveLength(2);
    expect(result[0]!.index).toBe(1);
    expect(result[0]!.sentinel).toBe(sentinelA);
    expect(result[1]!.index).toBe(3);
    expect(result[1]!.sentinel).toBe(sentinelB);
  });

  it("returns all 12 sentinels when all fields are well-known sentinels", () => {
    const fields = WELL_KNOWN_FIELDS.map((field) => ({
      ref: field,
      type: "text",
      value: { $paymentHandle: "h-multi", field },
    }));
    const result = findSentinelsInFields(fields);
    expect(result).toHaveLength(12);
    result.forEach((r, i) => {
      expect(r.index).toBe(i);
    });
  });

  it("detects forward-compat sentinels alongside well-known ones (e.g. 'email')", () => {
    const fields = [
      { ref: "pan", type: "text", value: { $paymentHandle: "h1", field: "pan" } },
      { ref: "email", type: "text", value: { $paymentHandle: "h1", field: "email" } },
    ];
    const result = findSentinelsInFields(fields);
    expect(result).toHaveLength(2);
    expect(result[1]!.sentinel.field).toBe("email");
  });

  it("handles fields with no value property", () => {
    const fields = [
      { ref: "ref1", type: "text" },
      { ref: "ref2", type: "checkbox" },
    ];
    expect(findSentinelsInFields(fields)).toEqual([]);
  });
});
