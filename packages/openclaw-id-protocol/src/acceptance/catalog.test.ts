import { describe, expect, it } from "vitest";
import { SPEC_11_ACCEPTANCE } from "../testing/acceptance.js";

describe("spec 11 acceptance catalog", () => {
  it("covers all twelve tests, each with protocol coverage or a named integration test", () => {
    expect(SPEC_11_ACCEPTANCE.map((entry) => entry.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const entry of SPEC_11_ACCEPTANCE) {
      expect(entry.protocol || entry.integration.length > 0).toBe(true);
      for (const test of entry.integration) {
        expect(test.name).toMatch(/^id-e2e: /);
      }
    }
    const names = SPEC_11_ACCEPTANCE.flatMap((entry) => entry.integration.map((test) => test.name));
    expect(new Set(names).size).toBe(names.length);
  });
});
