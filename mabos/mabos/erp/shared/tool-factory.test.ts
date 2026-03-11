import { describe, it, expect, vi } from "vitest";
import { createErpDomainTool } from "./tool-factory.js";
import type { ErpDomainDef, ErpToolContext } from "./tool-factory.js";

describe("createErpDomainTool", () => {
  const mockCtx = {
    agentId: "test-agent",
    agentDir: "/tmp/test",
    pg: {},
    typedb: {},
    syncEngine: null,
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as ErpToolContext;

  it("creates a tool with erp_ prefixed name", () => {
    const def: ErpDomainDef = {
      domain: "finance",
      description: "Financial operations",
      actions: [
        {
          name: "create_invoice",
          description: "Create invoice",
          params: {},
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
      ],
    };
    const tool = createErpDomainTool(def);
    expect(tool.name).toBe("erp_finance");
    expect(tool.description).toContain("Financial operations");
    expect(tool.description).toContain("create_invoice");
  });

  it("routes to the correct action handler", async () => {
    const handler = vi.fn().mockResolvedValue({ id: "inv-123" });
    const def: ErpDomainDef = {
      domain: "test",
      description: "Test domain",
      actions: [{ name: "create", description: "Create entity", params: {}, handler }],
    };
    const tool = createErpDomainTool(def);
    const result = await tool.execute({ action: "create", params: { name: "test" } }, mockCtx);
    expect(handler).toHaveBeenCalledWith({ name: "test" }, mockCtx);
    expect(result).toEqual({ id: "inv-123" });
  });

  it("returns error for unknown action", async () => {
    const def: ErpDomainDef = {
      domain: "test",
      description: "Test domain",
      actions: [],
    };
    const tool = createErpDomainTool(def);
    const result = (await tool.execute({ action: "nonexistent", params: {} }, mockCtx)) as Record<
      string,
      unknown
    >;
    expect(result.error).toContain("Unknown action: nonexistent");
  });

  it("passes empty params when none provided", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const def: ErpDomainDef = {
      domain: "test",
      description: "Test",
      actions: [{ name: "list", description: "List", params: {}, handler }],
    };
    const tool = createErpDomainTool(def);
    await tool.execute({ action: "list" }, mockCtx);
    expect(handler).toHaveBeenCalledWith({}, mockCtx);
  });

  it("includes input schema with action enum", () => {
    const def: ErpDomainDef = {
      domain: "orders",
      description: "Order management",
      actions: [
        { name: "create", description: "Create", params: {}, handler: vi.fn() },
        { name: "get", description: "Get", params: {}, handler: vi.fn() },
      ],
    };
    const tool = createErpDomainTool(def);
    expect(tool.inputSchema).toHaveProperty("properties");
    expect(tool.inputSchema).toHaveProperty("required", ["action"]);
  });
});
