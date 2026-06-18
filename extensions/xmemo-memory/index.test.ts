import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("xmemo-memory plugin entry", () => {
  it("exports a memory plugin with expected metadata", () => {
    expect(plugin.id).toBe("xmemo-memory");
    expect(plugin.kind).toBe("memory");
    expect(plugin.name).toBe("XMemo Cloud Memory");
  });

  it("register exposes the memory capability and tools without throwing", () => {
    const registered: {
      memoryCapability?: unknown;
      tools: string[];
      cli?: unknown;
    } = { tools: [] };

    const mockApi = {
      config: { plugins: {} } as never,
      registerMemoryCapability: (capability: { flushPlanResolver?: () => unknown }) => {
        registered.memoryCapability = capability;
      },
      registerTool: (tool: { name: string }) => {
        registered.tools.push(tool.name);
      },
      registerCli: (registrar: unknown) => {
        registered.cli = registrar;
      },
      on: () => {
        // lifecycle hooks are registered but not invoked here
      },
      logger: { info: () => {}, warn: () => {} },
      runtime: { config: { current: () => ({ plugins: {} }) } },
    };

    plugin.register(mockApi as never);

    expect(registered.memoryCapability).toBeDefined();
    expect(registered.tools).toContain("memory_search");
    expect(registered.tools).toContain("memory_get");
    expect(registered.tools).toContain("memory_store");
    expect(registered.tools).toContain("memory_forget");
    expect(registered.tools).toContain("xmemo_todo_create");
    expect(registered.tools).toContain("xmemo_record_event");
  });
});
