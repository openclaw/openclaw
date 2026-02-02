import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { ToolRegistry, createToolRegistry } from "./registry.js";
import type { AgentToolDefinition } from "../types.js";

describe("ToolRegistry", () => {
	let registry: ToolRegistry;

	const mockTool: AgentToolDefinition = {
		name: "test_tool",
		description: "A test tool",
		parameters: z.object({
			input: z.string(),
		}),
		execute: async ({ input }) => ({ result: input.toUpperCase() }),
	};

	const mockTool2: AgentToolDefinition = {
		name: "test_tool_2",
		description: "Another test tool",
		parameters: z.object({
			value: z.number(),
		}),
		execute: async ({ value }) => ({ doubled: value * 2 }),
	};

	beforeEach(() => {
		registry = createToolRegistry();
	});

	describe("register", () => {
		it("should register a tool", () => {
			registry.register(mockTool);
			expect(registry.has("test_tool")).toBe(true);
			expect(registry.size).toBe(1);
		});

		it("should throw when registering duplicate tool", () => {
			registry.register(mockTool);
			expect(() => registry.register(mockTool)).toThrow(
				'Tool "test_tool" is already registered'
			);
		});

		it("should support method chaining", () => {
			const result = registry.register(mockTool).register(mockTool2);
			expect(result).toBe(registry);
			expect(registry.size).toBe(2);
		});
	});

	describe("registerMany", () => {
		it("should register multiple tools", () => {
			registry.registerMany([mockTool, mockTool2]);
			expect(registry.size).toBe(2);
			expect(registry.has("test_tool")).toBe(true);
			expect(registry.has("test_tool_2")).toBe(true);
		});
	});

	describe("get", () => {
		it("should return registered tool", () => {
			registry.register(mockTool);
			const tool = registry.get("test_tool");
			expect(tool).toBeDefined();
			expect(tool?.name).toBe("test_tool");
		});

		it("should return undefined for unregistered tool", () => {
			expect(registry.get("nonexistent")).toBeUndefined();
		});
	});

	describe("unregister", () => {
		it("should remove a registered tool", () => {
			registry.register(mockTool);
			const result = registry.unregister("test_tool");
			expect(result).toBe(true);
			expect(registry.has("test_tool")).toBe(false);
		});

		it("should return false for unregistered tool", () => {
			expect(registry.unregister("nonexistent")).toBe(false);
		});

		it("should remove tool from groups", () => {
			registry.register(mockTool);
			registry.register(mockTool2);
			registry.createGroup("mygroup", ["test_tool", "test_tool_2"]);

			registry.unregister("test_tool");

			const group = registry.getGroup("mygroup");
			expect(group.length).toBe(1);
			expect(group[0].name).toBe("test_tool_2");
		});
	});

	describe("getAll", () => {
		it("should return all registered tools", () => {
			registry.register(mockTool);
			registry.register(mockTool2);

			const tools = registry.getAll();
			expect(tools.length).toBe(2);
		});
	});

	describe("getNames", () => {
		it("should return all tool names", () => {
			registry.register(mockTool);
			registry.register(mockTool2);

			const names = registry.getNames();
			expect(names).toContain("test_tool");
			expect(names).toContain("test_tool_2");
		});
	});

	describe("groups", () => {
		beforeEach(() => {
			registry.register(mockTool);
			registry.register(mockTool2);
		});

		it("should create a group", () => {
			registry.createGroup("mygroup", ["test_tool"]);
			const group = registry.getGroup("mygroup");
			expect(group.length).toBe(1);
			expect(group[0].name).toBe("test_tool");
		});

		it("should throw when creating group with unregistered tool", () => {
			expect(() =>
				registry.createGroup("mygroup", ["nonexistent"])
			).toThrow('Tool "nonexistent" is not registered');
		});

		it("should add to existing group", () => {
			registry.createGroup("mygroup", ["test_tool"]);
			registry.addToGroup("mygroup", "test_tool_2");

			const group = registry.getGroup("mygroup");
			expect(group.length).toBe(2);
		});

		it("should create group when adding to nonexistent group", () => {
			registry.addToGroup("newgroup", "test_tool");

			const group = registry.getGroup("newgroup");
			expect(group.length).toBe(1);
		});

		it("should return empty array for nonexistent group", () => {
			expect(registry.getGroup("nonexistent")).toEqual([]);
		});
	});

	describe("toCoreTools", () => {
		it("should convert all tools to CoreTool format", () => {
			registry.register(mockTool);
			registry.register(mockTool2);

			const coreTools = registry.toCoreTools();
			expect(Object.keys(coreTools)).toContain("test_tool");
			expect(Object.keys(coreTools)).toContain("test_tool_2");
			expect(coreTools.test_tool.description).toBe("A test tool");
		});
	});

	describe("toCoreToolsFiltered", () => {
		it("should convert specific tools to CoreTool format", () => {
			registry.register(mockTool);
			registry.register(mockTool2);

			const coreTools = registry.toCoreToolsFiltered(["test_tool"]);
			expect(Object.keys(coreTools)).toContain("test_tool");
			expect(Object.keys(coreTools)).not.toContain("test_tool_2");
		});
	});

	describe("groupToCoreTools", () => {
		it("should convert group tools to CoreTool format", () => {
			registry.register(mockTool);
			registry.register(mockTool2);
			registry.createGroup("mygroup", ["test_tool"]);

			const coreTools = registry.groupToCoreTools("mygroup");
			expect(Object.keys(coreTools)).toContain("test_tool");
			expect(Object.keys(coreTools)).not.toContain("test_tool_2");
		});
	});

	describe("clone", () => {
		it("should create an independent copy", () => {
			registry.register(mockTool);
			registry.createGroup("mygroup", ["test_tool"]);

			const cloned = registry.clone();

			// Original should not be affected by changes to clone
			cloned.register(mockTool2);
			expect(registry.size).toBe(1);
			expect(cloned.size).toBe(2);
		});
	});

	describe("clear", () => {
		it("should remove all tools and groups", () => {
			registry.register(mockTool);
			registry.register(mockTool2);
			registry.createGroup("mygroup", ["test_tool"]);

			registry.clear();

			expect(registry.size).toBe(0);
			expect(registry.getGroup("mygroup")).toEqual([]);
		});
	});
});
