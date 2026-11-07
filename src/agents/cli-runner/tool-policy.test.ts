import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolsAllow } from "./tool-policy.js";

describe("resolveCliRuntimeToolsAllow", () => {
  it("keeps every concrete restriction, including server-managed defaults", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});
