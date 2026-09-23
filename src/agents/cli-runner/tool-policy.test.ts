import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolsAllow, stripOpenClawMcpToolPrefix } from "./tool-policy.js";

describe("stripOpenClawMcpToolPrefix", () => {
  it("strips only the loopback transport prefix", () => {
    expect(stripOpenClawMcpToolPrefix("mcp__openclaw__memory_search")).toBe("memory_search");
    expect(stripOpenClawMcpToolPrefix("mcp_openclaw_memory_search")).toBe("memory_search");
    expect(stripOpenClawMcpToolPrefix("memory_search")).toBe("memory_search");
    expect(stripOpenClawMcpToolPrefix("mcp__other__tool")).toBe("mcp__other__tool");
    expect(stripOpenClawMcpToolPrefix("mcp_other_tool")).toBe("mcp_other_tool");
  });
});

describe("resolveCliRuntimeToolsAllow", () => {
  it("keeps every concrete restriction, including server-managed defaults", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"], true)).toEqual(["memory_search"]);
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});
