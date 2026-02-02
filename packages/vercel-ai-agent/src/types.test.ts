import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMessageId, toCoreTool } from "./types.js";
import type { AgentToolDefinition } from "./types.js";

describe("types utilities", () => {
	describe("createMessageId", () => {
		it("should create unique IDs", () => {
			const id1 = createMessageId();
			const id2 = createMessageId();

			expect(id1).not.toBe(id2);
		});

		it("should create IDs with msg_ prefix", () => {
			const id = createMessageId();
			expect(id.startsWith("msg_")).toBe(true);
		});

		it("should include timestamp-like component", () => {
			const id = createMessageId();
			// Should have format: msg_timestamp_random
			const parts = id.split("_");
			expect(parts.length).toBe(3);
		});
	});

	describe("toCoreTool", () => {
		it("should convert AgentToolDefinition to CoreTool", () => {
			const toolDef: AgentToolDefinition = {
				name: "test_tool",
				description: "A test tool",
				parameters: z.object({
					input: z.string(),
				}),
				execute: async ({ input }) => ({ result: input }),
			};

			const coreTool = toCoreTool(toolDef);

			expect(coreTool.description).toBe("A test tool");
			expect(coreTool.parameters).toBe(toolDef.parameters);
			expect(typeof coreTool.execute).toBe("function");
		});

		it("should preserve execute function behavior", async () => {
			const toolDef: AgentToolDefinition = {
				name: "calculator",
				description: "Add numbers",
				parameters: z.object({
					a: z.number(),
					b: z.number(),
				}),
				execute: async ({ a, b }) => ({ sum: a + b }),
			};

			const coreTool = toCoreTool(toolDef);

			const result = await coreTool.execute!(
				{ a: 5, b: 3 },
				{ toolCallId: "test", messages: [] }
			);

			expect(result).toEqual({ sum: 8 });
		});
	});
});
