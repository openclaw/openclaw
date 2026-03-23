import { describe, expect, it, vi } from "vitest";
import plugin, { buildPromptSection } from "./index.js";

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});

describe("plugin registration", () => {
  it("registers memory tools independently so one unavailable tool does not suppress the other", () => {
    const registerTool = vi.fn();
    const registerMemoryPromptSection = vi.fn();
    const registerCli = vi.fn();
    const searchTool = { name: "memory_search" };
    const getTool = null;
    const api = {
      registerTool,
      registerMemoryPromptSection,
      registerCli,
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn(() => searchTool),
          createMemoryGetTool: vi.fn(() => getTool),
          registerMemoryCli: vi.fn(),
        },
      },
    };

    plugin.register(api as never);

    expect(registerMemoryPromptSection).toHaveBeenCalledWith(buildPromptSection);
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool.mock.calls[0]?.[1]).toEqual({ names: ["memory_search"] });
    expect(registerTool.mock.calls[1]?.[1]).toEqual({ names: ["memory_get"] });

    const searchFactory = registerTool.mock.calls[0]?.[0] as
      | ((ctx: unknown) => unknown)
      | undefined;
    const getFactory = registerTool.mock.calls[1]?.[0] as ((ctx: unknown) => unknown) | undefined;
    const ctx = { config: { plugins: {} }, sessionKey: "agent:main:slack:dm:u123" };

    expect(searchFactory?.(ctx)).toBe(searchTool);
    expect(getFactory?.(ctx)).toBeNull();
  });
});
