import { expect, it, vi } from "vitest";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";

vi.mock("./subagents/registry/subagent-registry.js", () => {
  throw new Error("ordinary Code Mode must not load the subagent registry");
});

vi.mock("./tools/agents-wait-tool.js", () => {
  throw new Error("ordinary Code Mode must not load the collector waiter");
});

it.each([false, true])(
  "executes ordinary tools without optional runtime imports (swarm=%s)",
  async (enabled) => {
    const { fakeTool, runUntilCompleted } = await import("./code-mode.test-support.js");
    const { createToolSearchCatalogRef, clearToolSearchCatalog } =
      await import("./tool-search-catalog.js");
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true, swarm: { enabled } } };
    const ctx = { config, runtimeConfig: config, catalogRef };
    const tools = createCodeModeTools(ctx);
    const execute = vi.fn(async () => ({ content: [], details: { answer: 42 } }));
    const ordinary = fakeTool("ordinary", "Return a structured answer.");
    ordinary.execute = execute;
    try {
      applyCodeModeCatalog({ tools: [...tools, ordinary], config, catalogRef });
      const result = await runUntilCompleted({
        execTool: tools[0]!,
        waitTool: tools[1]!,
        code: "return await ordinary({});",
      });
      expect(result).toMatchObject({ status: "completed", value: { answer: 42 } });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  },
);
