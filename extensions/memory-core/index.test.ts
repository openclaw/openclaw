import { describe, expect, it, vi } from "vitest";
import plugin, { buildPromptSection } from "./index.js";

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toEqual([]);
  });

  it("returns Memory Recall section when memory_search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("returns Memory Recall section when memory_get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
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
