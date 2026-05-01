import { describe, expect, it } from "vitest";
import { isFillSentinel, findSentinelsInFields, FILL_SENTINEL_FIELDS } from "./sentinel.js";

// ---------------------------------------------------------------------------
// isFillSentinel — valid sentinels
// ---------------------------------------------------------------------------

describe("isFillSentinel — valid field values", () => {
  it.each(FILL_SENTINEL_FIELDS)('returns true for field "%s"', (field) => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field })).toBe(true);
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
// isFillSentinel — missing or wrong field
// ---------------------------------------------------------------------------

describe("isFillSentinel — field constraints", () => {
  it("returns false when field is missing (partial sentinel)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc" })).toBe(false);
  });

  it("returns true for field 'exp_mm_yy'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "exp_mm_yy" })).toBe(true);
  });

  it("returns true for field 'exp_mm_yyyy'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "exp_mm_yyyy" })).toBe(true);
  });

  it("returns true for field 'billing_line1'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_line1" })).toBe(true);
  });

  it("returns true for field 'billing_city'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_city" })).toBe(true);
  });

  it("returns true for field 'billing_state'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_state" })).toBe(true);
  });

  it("returns true for field 'billing_postal_code'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_postal_code" })).toBe(
      true,
    );
  });

  it("returns true for field 'billing_country'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_country" })).toBe(true);
  });

  it("returns false for field value 'billing-line-1' (hyphens — wrong separator)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing-line-1" })).toBe(false);
  });

  it("returns false for field value 'billingLine1' (camelCase — wrong form)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billingLine1" })).toBe(false);
  });

  it("returns false for field value 'billingCity' (camelCase — wrong form)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billingCity" })).toBe(false);
  });

  it("returns false for field value 'billing_zip' (unknown billing sub-field)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "billing_zip" })).toBe(false);
  });

  it("returns false for field value 'exp_mmyy' (no slash — wrong variant)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "exp_mmyy" })).toBe(false);
  });

  it("returns false for field value 'exp_mm_y' (truncated variant)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "exp_mm_y" })).toBe(false);
  });

  it("returns false for field value 'foo'", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "foo" })).toBe(false);
  });

  it("returns false for field value 'PAN' (wrong case)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "PAN" })).toBe(false);
  });

  it("returns false for field value 'CVV' (wrong case)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "CVV" })).toBe(false);
  });

  it("returns false for field value '' (empty string)", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: "" })).toBe(false);
  });

  it("returns false when field is a number", () => {
    expect(isFillSentinel({ $paymentHandle: "handle-abc", field: 1 })).toBe(false);
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
    const sentinel = { $paymentHandle: "h1", field: "pan" as const };
    const fields = [{ ref: "pan-field", type: "text", value: sentinel }];
    const result = findSentinelsInFields(fields);
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.sentinel).toBe(sentinel);
  });

  it("returns only the sentinel indices from a mixed array", () => {
    const sentinelA = { $paymentHandle: "h1", field: "pan" as const };
    const sentinelB = { $paymentHandle: "h1", field: "cvv" as const };
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

  it("returns all 12 sentinels when all fields are sentinels", () => {
    const fields = FILL_SENTINEL_FIELDS.map((field) => ({
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

  it("handles fields with no value property", () => {
    const fields = [
      { ref: "ref1", type: "text" },
      { ref: "ref2", type: "checkbox" },
    ];
    expect(findSentinelsInFields(fields)).toEqual([]);
  });
});
