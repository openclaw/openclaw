import { describe, it, expect } from "vitest";
import {
	calculatorTool,
	dateTimeTool,
	jsonTool,
	stringTool,
	waitTool,
	createMemoryTool,
} from "./builtin.js";

describe("Built-in Tools", () => {
	describe("calculatorTool", () => {
		it("should add numbers", async () => {
			const result = await calculatorTool.execute(
				{ operation: "add", a: 5, b: 3 },
				{ toolCallId: "test", messages: [] }
			);
			expect(result).toEqual({ result: 8 });
		});

		it("should subtract numbers", async () => {
			const result = await calculatorTool.execute(
				{ operation: "subtract", a: 10, b: 4 },
				{ toolCallId: "test", messages: [] }
			);
			expect(result).toEqual({ result: 6 });
		});

		it("should multiply numbers", async () => {
			const result = await calculatorTool.execute(
				{ operation: "multiply", a: 6, b: 7 },
				{ toolCallId: "test", messages: [] }
			);
			expect(result).toEqual({ result: 42 });
		});

		it("should divide numbers", async () => {
			const result = await calculatorTool.execute(
				{ operation: "divide", a: 20, b: 5 },
				{ toolCallId: "test", messages: [] }
			);
			expect(result).toEqual({ result: 4 });
		});

		it("should throw on division by zero", async () => {
			await expect(
				calculatorTool.execute(
					{ operation: "divide", a: 10, b: 0 },
					{ toolCallId: "test", messages: [] }
				)
			).rejects.toThrow("Division by zero");
		});
	});

	describe("dateTimeTool", () => {
		it("should return ISO format by default", async () => {
			const result = (await dateTimeTool.execute(
				{},
				{ toolCallId: "test", messages: [] }
			)) as { iso: string; timezone: string };

			expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
			expect(result.timezone).toBe("UTC");
		});

		it("should return unix timestamp", async () => {
			const result = (await dateTimeTool.execute(
				{ format: "unix" },
				{ toolCallId: "test", messages: [] }
			)) as { timestamp: number };

			expect(typeof result.timestamp).toBe("number");
			expect(result.timestamp).toBeGreaterThan(0);
		});

		it("should return date only", async () => {
			const result = (await dateTimeTool.execute(
				{ format: "date_only" },
				{ toolCallId: "test", messages: [] }
			)) as { date: string };

			expect(result.date).toBeDefined();
			expect(typeof result.date).toBe("string");
		});
	});

	describe("jsonTool", () => {
		it("should parse valid JSON", async () => {
			const result = (await jsonTool.execute(
				{ action: "parse", input: '{"key": "value"}' },
				{ toolCallId: "test", messages: [] }
			)) as { success: boolean; data: unknown };

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ key: "value" });
		});

		it("should return error for invalid JSON", async () => {
			const result = (await jsonTool.execute(
				{ action: "parse", input: "not valid json" },
				{ toolCallId: "test", messages: [] }
			)) as { success: boolean; error: string };

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("should validate valid JSON", async () => {
			const result = (await jsonTool.execute(
				{ action: "validate", input: '{"valid": true}' },
				{ toolCallId: "test", messages: [] }
			)) as { valid: boolean };

			expect(result.valid).toBe(true);
		});

		it("should validate invalid JSON", async () => {
			const result = (await jsonTool.execute(
				{ action: "validate", input: "invalid" },
				{ toolCallId: "test", messages: [] }
			)) as { valid: boolean; error: string };

			expect(result.valid).toBe(false);
		});

		it("should stringify with pretty print", async () => {
			const result = (await jsonTool.execute(
				{ action: "stringify", input: '{"a":1}', pretty: true },
				{ toolCallId: "test", messages: [] }
			)) as { success: boolean; json: string };

			expect(result.success).toBe(true);
			expect(result.json).toContain("\n");
		});
	});

	describe("stringTool", () => {
		it("should convert to uppercase", async () => {
			const result = (await stringTool.execute(
				{ operation: "uppercase", input: "hello" },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("HELLO");
		});

		it("should convert to lowercase", async () => {
			const result = (await stringTool.execute(
				{ operation: "lowercase", input: "HELLO" },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("hello");
		});

		it("should capitalize", async () => {
			const result = (await stringTool.execute(
				{ operation: "capitalize", input: "hello WORLD" },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("Hello world");
		});

		it("should trim whitespace", async () => {
			const result = (await stringTool.execute(
				{ operation: "trim", input: "  hello  " },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("hello");
		});

		it("should split string", async () => {
			const result = (await stringTool.execute(
				{ operation: "split", input: "a,b,c", arg: "," },
				{ toolCallId: "test", messages: [] }
			)) as { result: string[] };

			expect(result.result).toEqual(["a", "b", "c"]);
		});

		it("should get length", async () => {
			const result = (await stringTool.execute(
				{ operation: "length", input: "hello" },
				{ toolCallId: "test", messages: [] }
			)) as { length: number };

			expect(result.length).toBe(5);
		});

		it("should reverse string", async () => {
			const result = (await stringTool.execute(
				{ operation: "reverse", input: "hello" },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("olleh");
		});

		it("should replace substring", async () => {
			const result = (await stringTool.execute(
				{ operation: "replace", input: "hello world", arg: "world", arg2: "there" },
				{ toolCallId: "test", messages: [] }
			)) as { result: string };

			expect(result.result).toBe("hello there");
		});
	});

	describe("waitTool", () => {
		it("should wait for specified time", async () => {
			const start = Date.now();
			const result = (await waitTool.execute(
				{ milliseconds: 50 },
				{ toolCallId: "test", messages: [] }
			)) as { waited: number; message: string };

			const elapsed = Date.now() - start;

			expect(result.waited).toBe(50);
			expect(elapsed).toBeGreaterThanOrEqual(50);
		});
	});

	describe("createMemoryTool", () => {
		it("should store and retrieve values", async () => {
			const memoryTool = createMemoryTool();

			// Set a value
			await memoryTool.execute(
				{ action: "set", key: "test", value: "hello" },
				{ toolCallId: "test", messages: [] }
			);

			// Get the value
			const result = (await memoryTool.execute(
				{ action: "get", key: "test" },
				{ toolCallId: "test", messages: [] }
			)) as { found: boolean; key: string; value: unknown };

			expect(result.found).toBe(true);
			expect(result.value).toBe("hello");
		});

		it("should return not found for missing key", async () => {
			const memoryTool = createMemoryTool();

			const result = (await memoryTool.execute(
				{ action: "get", key: "missing" },
				{ toolCallId: "test", messages: [] }
			)) as { found: boolean; key: string };

			expect(result.found).toBe(false);
		});

		it("should delete values", async () => {
			const memoryTool = createMemoryTool();

			await memoryTool.execute(
				{ action: "set", key: "test", value: "hello" },
				{ toolCallId: "test", messages: [] }
			);

			const deleteResult = (await memoryTool.execute(
				{ action: "delete", key: "test" },
				{ toolCallId: "test", messages: [] }
			)) as { success: boolean; existed: boolean };

			expect(deleteResult.success).toBe(true);
			expect(deleteResult.existed).toBe(true);

			const getResult = (await memoryTool.execute(
				{ action: "get", key: "test" },
				{ toolCallId: "test", messages: [] }
			)) as { found: boolean };

			expect(getResult.found).toBe(false);
		});

		it("should list keys", async () => {
			const memoryTool = createMemoryTool();

			await memoryTool.execute(
				{ action: "set", key: "key1", value: 1 },
				{ toolCallId: "test", messages: [] }
			);
			await memoryTool.execute(
				{ action: "set", key: "key2", value: 2 },
				{ toolCallId: "test", messages: [] }
			);

			const result = (await memoryTool.execute(
				{ action: "list" },
				{ toolCallId: "test", messages: [] }
			)) as { keys: string[] };

			expect(result.keys).toContain("key1");
			expect(result.keys).toContain("key2");
		});

		it("should clear all values", async () => {
			const memoryTool = createMemoryTool();

			await memoryTool.execute(
				{ action: "set", key: "key1", value: 1 },
				{ toolCallId: "test", messages: [] }
			);

			await memoryTool.execute(
				{ action: "clear" },
				{ toolCallId: "test", messages: [] }
			);

			const result = (await memoryTool.execute(
				{ action: "list" },
				{ toolCallId: "test", messages: [] }
			)) as { keys: string[] };

			expect(result.keys).toHaveLength(0);
		});

		it("should expose memory map directly", () => {
			const memoryTool = createMemoryTool();
			expect(memoryTool.memory).toBeInstanceOf(Map);
		});
	});
});
