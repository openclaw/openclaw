import { describe, expect, it } from "vitest";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";

describe("resolveGlobalLane", () => {
  it("defaults to main lane when no lane is provided", () => {
    expect(resolveGlobalLane()).toBe(CommandLane.Main);
    expect(resolveGlobalLane("")).toBe(CommandLane.Main);
    expect(resolveGlobalLane("  ")).toBe(CommandLane.Main);
  });

  it("partitions default global lane by agent when agent id is provided", () => {
    expect(resolveGlobalLane(undefined, "risk")).toBe("agent:risk");
    expect(resolveGlobalLane("", "gateway")).toBe("agent:gateway");
    expect(resolveGlobalLane("  ", "ops")).toBe("agent:ops");
  });

  it("maps cron lane to nested lane to prevent deadlocks", () => {
    // When cron jobs trigger nested agent runs, the outer execution holds
    // the cron lane slot. Inner work must use a separate lane to avoid
    // deadlock. See: https://github.com/openclaw/openclaw/issues/44805
    expect(resolveGlobalLane("cron")).toBe(CommandLane.Nested);
    expect(resolveGlobalLane("  cron  ")).toBe(CommandLane.Nested);
  });

  it("preserves other lanes as-is", () => {
    expect(resolveGlobalLane("main")).toBe(CommandLane.Main);
    expect(resolveGlobalLane("subagent")).toBe(CommandLane.Subagent);
    expect(resolveGlobalLane("nested")).toBe(CommandLane.Nested);
    expect(resolveGlobalLane("custom-lane")).toBe("custom-lane");
    expect(resolveGlobalLane(" custom ")).toBe("custom");
  });

  it("keeps explicit lane higher priority than inferred agent lane", () => {
    expect(resolveGlobalLane("main", "risk")).toBe(CommandLane.Main);
    expect(resolveGlobalLane("custom", "gateway")).toBe("custom");
  });
});

describe("resolveSessionLane", () => {
  it("defaults to main lane and prefixes with session:", () => {
    expect(resolveSessionLane("")).toBe("session:main");
    expect(resolveSessionLane("  ")).toBe("session:main");
  });

  it("adds session: prefix if not present", () => {
    expect(resolveSessionLane("abc123")).toBe("session:abc123");
    expect(resolveSessionLane(" xyz ")).toBe("session:xyz");
  });

  it("preserves existing session: prefix", () => {
    expect(resolveSessionLane("session:abc")).toBe("session:abc");
    expect(resolveSessionLane("session:main")).toBe("session:main");
  });
});
