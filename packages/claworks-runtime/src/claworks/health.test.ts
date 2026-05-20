import { describe, expect, it } from "vitest";
import { resolveHealthStatus } from "./health.js";

describe("resolveHealthStatus", () => {
  it("returns unavailable when any error check", () => {
    expect(
      resolveHealthStatus([
        { id: "a", status: "ok", message: null },
        { id: "b", status: "error", message: "db" },
      ]),
    ).toBe("unavailable");
  });

  it("returns degraded on warn only", () => {
    expect(resolveHealthStatus([{ id: "a", status: "warn", message: "x" }])).toBe("degraded");
  });
});
