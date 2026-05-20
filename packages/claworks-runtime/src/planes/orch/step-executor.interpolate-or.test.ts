import { describe, expect, it } from "vitest";
import { interpolate } from "./step-executor.js";

describe("interpolate or fallback", () => {
  it("resolves {{ key or 'default' }}", () => {
    expect(interpolate("tenant={{ tenant_id or '(none)' }}", { tenant_id: "acme" })).toBe(
      "tenant=acme",
    );
    expect(interpolate("tenant={{ tenant_id or '(none)' }}", {})).toBe("tenant=(none)");
  });
});
