import { describe, expect, it } from "vitest";
import { createLazyToolsPlugin, TOOLKITS, CORE_TOOLS } from "./index.js";

describe("lazy-tools plugin logic", () => {
  it("loadToolkit returns toolkit info and updates state", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const result = plugin.loadToolkit("messaging", loaded);

    expect("loaded" in result && result.loaded).toBe("messaging");
    expect("tools" in result && result.tools).toEqual(TOOLKITS.messaging);
    expect(loaded.has("messaging")).toBe(true);
  });

  it("loadToolkit rejects unknown toolkit", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const result = plugin.loadToolkit("nonexistent", loaded);

    expect("error" in result).toBe(true);
  });

  it("filterTools keeps core tools, hides unloaded toolkit tools", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "write", description: "write", parameters: {} },
      { name: "exec", description: "exec", parameters: {} },
      { name: "edit", description: "edit", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
      { name: "memory_search", description: "mem", parameters: {} },
      { name: "some_unknown_tool", description: "unknown", parameters: {} },
    ];

    const filtered = plugin.filterTools(tools, loaded);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("exec");
    expect(names).toContain("edit");
    expect(names).toContain("load_toolkit");
    expect(names).toContain("some_unknown_tool");
    expect(names).not.toContain("message");
    expect(names).not.toContain("memory_search");
  });

  it("filterTools shows tools from loaded toolkits", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set(["messaging"]);
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
      { name: "sessions_send", description: "send", parameters: {} },
      { name: "memory_search", description: "mem", parameters: {} },
    ];

    const filtered = plugin.filterTools(tools, loaded);
    const names = filtered.map((t) => t.name);

    expect(names).toContain("message");
    expect(names).toContain("sessions_send");
    expect(names).not.toContain("memory_search");
  });

  it("loadToolkit then filterTools shows newly loaded tools", () => {
    const plugin = createLazyToolsPlugin();
    const loaded = new Set<string>();
    const tools = [
      { name: "read", description: "read", parameters: {} },
      { name: "load_toolkit", description: "load", parameters: {} },
      { name: "message", description: "msg", parameters: {} },
    ];

    expect(plugin.filterTools(tools, loaded).map((t) => t.name)).not.toContain("message");
    plugin.loadToolkit("messaging", loaded);
    expect(plugin.filterTools(tools, loaded).map((t) => t.name)).toContain("message");
  });
});
