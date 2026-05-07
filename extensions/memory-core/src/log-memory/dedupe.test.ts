import { describe, expect, it } from "vitest";
import { computeEntryId } from "./dedupe.js";

describe("computeEntryId", () => {
  it("yields stable hash for same inputs", () => {
    const ts = new Date("2026-05-07T00:00:00Z");
    const a = computeEntryId({ timestamp: ts, service: "diagfw", message: "probe" });
    const b = computeEntryId({ timestamp: ts, service: "diagfw", message: "probe" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by message", () => {
    const ts = new Date("2026-05-07T00:00:00Z");
    const a = computeEntryId({ timestamp: ts, service: "diagfw", message: "probe" });
    const b = computeEntryId({ timestamp: ts, service: "diagfw", message: "probe2" });
    expect(a).not.toBe(b);
  });

  it("differs by service", () => {
    const ts = new Date("2026-05-07T00:00:00Z");
    const a = computeEntryId({ timestamp: ts, service: "a", message: "probe" });
    const b = computeEntryId({ timestamp: ts, service: "b", message: "probe" });
    expect(a).not.toBe(b);
  });
});
