import { describe, expect, it } from "vitest";
import { clearFieldValue, getFieldValue, setFieldValue } from "./config-store.ts";

describe("config-store helpers", () => {
  it("sets and reads nested fields", () => {
    const next = setFieldValue({}, "gateway.auth.token", "abc123");
    expect(getFieldValue(next, "gateway.auth.token")).toBe("abc123");
    expect(next.gateway).toBeTruthy();
  });

  it("clears nested fields and prunes empty parents", () => {
    const seeded = setFieldValue({}, "gateway.auth.token", "abc123");
    const cleared = clearFieldValue(seeded, "gateway.auth.token");

    expect(getFieldValue(cleared, "gateway.auth.token")).toBeUndefined();
    expect(cleared.gateway).toBeUndefined();
  });
});
