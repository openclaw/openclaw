import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("payment plugin entry", () => {
  it("exposes id 'payment'", () => {
    expect(plugin.id).toBe("payment");
  });

  it("exposes a name", () => {
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name.length).toBeGreaterThan(0);
  });

  it("exposes a register function", () => {
    expect(typeof plugin.register).toBe("function");
  });
});
