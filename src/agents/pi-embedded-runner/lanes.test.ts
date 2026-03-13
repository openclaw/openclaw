import { describe, expect, it } from "vitest";
import { CommandLane } from "../../process/lanes.js";
import { resolveEmbeddedSessionLane, resolveGlobalLane, resolveSessionLane } from "./lanes.js";

describe("pi embedded runner lane resolution", () => {
  it("prefixes session lanes", () => {
    expect(resolveSessionLane("abc")).toBe("session:abc");
    expect(resolveEmbeddedSessionLane("session:abc")).toBe("session:abc");
  });

  it("maps cron global lane to nested to avoid self-deadlock", () => {
    expect(resolveGlobalLane(CommandLane.Cron)).toBe(CommandLane.Nested);
    expect(resolveGlobalLane("cron")).toBe(CommandLane.Nested);
  });

  it("preserves other global lanes", () => {
    expect(resolveGlobalLane()).toBe(CommandLane.Main);
    expect(resolveGlobalLane(CommandLane.Subagent)).toBe(CommandLane.Subagent);
    expect(resolveGlobalLane(CommandLane.Nested)).toBe(CommandLane.Nested);
  });
});
