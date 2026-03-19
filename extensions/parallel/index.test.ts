import { describe, expect, it } from "vitest";
import parallelPlugin from "./index.js";

describe("parallel plugin", () => {
  it("has correct plugin metadata", () => {
    expect(parallelPlugin.id).toBe("parallel");
    expect(parallelPlugin.name).toBe("Parallel Plugin");
  });

  it("exposes a register function", () => {
    expect(typeof parallelPlugin.register).toBe("function");
  });
});
