import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createMullusiTools } from "./mullusi-tools.js";

function readToolByName() {
  return new Map(createMullusiTools().map((tool) => [tool.name, tool]));
}

describe("createMullusiTools owner authorization", () => {
  it("marks owner-only core tools in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("cron")?.ownerOnly).toBe(true);
    expect(tools.get("gateway")?.ownerOnly).toBe(true);
    expect(tools.get("nodes")?.ownerOnly).toBe(true);
  });

  it("keeps canvas non-owner-only in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("canvas")).toBeDefined();
    expect(tools.get("canvas")?.ownerOnly).not.toBe(true);
  });
});
