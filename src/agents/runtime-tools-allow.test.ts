import { describe, expect, it } from "vitest";
import { isRestrictiveRuntimeToolsAllow } from "./runtime-tools-allow.js";

describe("isRestrictiveRuntimeToolsAllow", () => {
  it("treats an absent policy as non-restrictive", () => {
    expect(isRestrictiveRuntimeToolsAllow(undefined)).toBe(false);
  });

  it("treats a wildcard policy as non-restrictive", () => {
    expect(isRestrictiveRuntimeToolsAllow(["*"])).toBe(false);
    expect(isRestrictiveRuntimeToolsAllow(["read", "web_search", "*"])).toBe(false);
    expect(isRestrictiveRuntimeToolsAllow(["*", "cron"])).toBe(false);
  });

  it("treats an explicit allow-list as restrictive", () => {
    expect(isRestrictiveRuntimeToolsAllow([])).toBe(true);
    expect(isRestrictiveRuntimeToolsAllow(["read"])).toBe(true);
    expect(isRestrictiveRuntimeToolsAllow(["read", "web_search"])).toBe(true);
  });
});
