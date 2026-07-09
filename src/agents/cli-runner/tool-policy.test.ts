import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolsAllow } from "./tool-policy.js";

describe("resolveCliRuntimeToolsAllow", () => {
  it("drops unrestricted and auto-applied caps but preserves explicit restrictions", () => {
    expect(resolveCliRuntimeToolsAllow()).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["read", "cron"], true)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["*", "read"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow([])).toEqual([]);
    expect(resolveCliRuntimeToolsAllow(["read", "write"])).toEqual(["read", "write"]);
  });
});
