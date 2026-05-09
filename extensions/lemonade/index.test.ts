import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("lemonade plugin", () => {
  it("exports plugin entry", () => {
    expect(plugin.id).toBe("lemonade");
    expect(plugin.name).toBe("Lemonade Provider");
  });
});
