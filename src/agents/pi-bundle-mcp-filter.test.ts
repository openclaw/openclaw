import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../logger.js";
import { applyMcpToolFilter } from "./pi-bundle-mcp-filter.js";

type FakeTool = { name: string };

function makeTools(...names: string[]): FakeTool[] {
  return names.map((name) => ({ name }));
}

describe("applyMcpToolFilter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the input unchanged when the filter is undefined", () => {
    const tools = makeTools("a", "b", "c");
    const result = applyMcpToolFilter({ serverName: "srv", tools });
    expect(result).toEqual(tools);
    expect(result).toBe(tools);
  });

  it("returns the input unchanged when the filter has neither allow nor deny", () => {
    const tools = makeTools("a", "b");
    const result = applyMcpToolFilter({ serverName: "srv", tools, filter: {} });
    expect(result).toBe(tools);
  });

  it("keeps only tools listed in allow", () => {
    const tools = makeTools("alpha", "beta", "gamma");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["alpha", "gamma"] },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha", "gamma"]);
  });

  it("drops tools listed in deny and keeps the rest", () => {
    const tools = makeTools("alpha", "beta", "gamma");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { deny: ["beta"] },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha", "gamma"]);
  });

  it("applies allow first, then deny carves exceptions", () => {
    const tools = makeTools("alpha", "beta", "gamma", "delta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["alpha", "beta", "gamma"], deny: ["beta"] },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha", "gamma"]);
  });

  it("drops a tool listed in both allow and deny (deny wins on overlap)", () => {
    const tools = makeTools("alpha", "beta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["alpha", "beta"], deny: ["beta"] },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha"]);
  });

  it("dedupes allow entries so a duplicated typo only warns once", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha");
    applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["alpha", "nope", "nope"] },
    });
    const notFoundCalls = warnSpy.mock.calls.filter(([message]) =>
      typeof message === "string" && message.includes('"nope"'),
    );
    expect(notFoundCalls).toHaveLength(1);
  });

  it("matches case-sensitively — mismatched case is filtered out and warns", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("list_work_items");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["List_work_items"] },
    });
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"List_work_items"'),
    );
  });

  it("warns on unknown allow entries with the grep-friendly phrasing", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha");
    applyMcpToolFilter({
      serverName: "plane",
      tools,
      filter: { allow: ["alpha", "nonexistent_tool"] },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: allow-list entry "nonexistent_tool" not found on server "plane" (typo or upstream rename?)',
    );
  });

  it("does NOT warn on unknown deny entries (denying a missing tool is idempotent)", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha");
    applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { deny: ["alpha", "already_gone"] },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits an info log with the post-filter count when the filter changes the tool list", () => {
    const infoSpy = vi.spyOn(logger, "logInfo").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta", "gamma");
    applyMcpToolFilter({
      serverName: "plane",
      tools,
      filter: { allow: ["alpha"] },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "plane" filter applied — 1 of 3 tools exposed',
    );
  });

  it("does not emit an info log when the filter is a no-op on the tool list", () => {
    const infoSpy = vi.spyOn(logger, "logInfo").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta");
    applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: ["alpha", "beta"] },
    });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("coerces a non-array allow (e.g. bundle-provided truthy garbage) to undefined and warns", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: true as unknown as [string, ...string[]] },
    });
    // allow ignored → tools pass through unchanged
    expect(result).toBe(tools);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.allow is not an array — ignoring',
    );
  });

  it("coerces a non-array deny (e.g. {}) to undefined and warns", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { deny: {} as unknown as [string, ...string[]] },
    });
    expect(result).toBe(tools);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.deny is not an array — ignoring',
    );
  });

  it("applies a valid allow even when deny is a non-array", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta", "gamma");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: {
        allow: ["alpha", "beta"],
        deny: "nope" as unknown as [string, ...string[]],
      },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.deny is not an array — ignoring',
    );
  });

  it("rejects an empty allow (bundle path) and passes tools through unchanged with a warn", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { allow: [] as unknown as [string, ...string[]] },
    });
    // allow: [] must not silently hide every tool — bundle configs bypass Zod's .min(1)
    expect(result).toBe(tools);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.allow is empty — ignoring (use deny to remove specific tools)',
    );
  });

  it("rejects an empty deny (bundle path) and passes tools through unchanged with a warn", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: { deny: [] as unknown as [string, ...string[]] },
    });
    expect(result).toBe(tools);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.deny is empty — ignoring',
    );
  });

  it("applies a valid allow even when deny is an empty array", () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const tools = makeTools("alpha", "beta", "gamma");
    const result = applyMcpToolFilter({
      serverName: "srv",
      tools,
      filter: {
        allow: ["alpha", "beta"],
        deny: [] as unknown as [string, ...string[]],
      },
    });
    expect(result.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(warnSpy).toHaveBeenCalledWith(
      'bundle-mcp: server "srv" tools.deny is empty — ignoring',
    );
  });
});
