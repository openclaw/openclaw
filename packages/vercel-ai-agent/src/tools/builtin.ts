import { tool } from "ai";
import { z } from "zod";

/**
 * Calculator tool for basic arithmetic operations
 */
export const calculatorTool = tool({
	description:
		"Perform basic arithmetic calculations. Supports addition, subtraction, multiplication, and division.",
	inputSchema: z.object({
		operation: z
			.enum(["add", "subtract", "multiply", "divide"])
			.describe("The arithmetic operation to perform"),
		a: z.number().describe("The first operand"),
		b: z.number().describe("The second operand"),
	}),
	execute: async ({ operation, a, b }) => {
		switch (operation) {
			case "add":
				return { result: a + b };
			case "subtract":
				return { result: a - b };
			case "multiply":
				return { result: a * b };
			case "divide":
				if (b === 0) {
					throw new Error("Division by zero is not allowed");
				}
				return { result: a / b };
		}
	},
});

/**
 * Current date/time tool
 */
export const dateTimeTool = tool({
	description:
		"Get the current date and time in various formats and timezones",
	inputSchema: z.object({
		timezone: z
			.string()
			.optional()
			.describe(
				'IANA timezone name (e.g., "America/New_York", "Europe/London"). Defaults to UTC.'
			),
		format: z
			.enum(["iso", "unix", "human", "date_only", "time_only"])
			.optional()
			.describe("Output format. Defaults to iso."),
	}),
	execute: async ({ timezone = "UTC", format = "iso" }) => {
		const now = new Date();
		const options: Intl.DateTimeFormatOptions = { timeZone: timezone };

		switch (format) {
			case "unix":
				return { timestamp: Math.floor(now.getTime() / 1000) };
			case "human":
				return {
					datetime: now.toLocaleString("en-US", {
						...options,
						dateStyle: "full",
						timeStyle: "long",
					}),
				};
			case "date_only":
				return {
					date: now.toLocaleDateString("en-US", {
						...options,
						dateStyle: "full",
					}),
				};
			case "time_only":
				return {
					time: now.toLocaleTimeString("en-US", {
						...options,
						timeStyle: "long",
					}),
				};
			case "iso":
			default:
				return { iso: now.toISOString(), timezone };
		}
	},
});

/**
 * JSON parser/validator tool
 */
export const jsonTool = tool({
	description: "Parse and validate JSON strings, or convert objects to JSON",
	inputSchema: z.object({
		action: z
			.enum(["parse", "stringify", "validate"])
			.describe("The action to perform"),
		input: z.string().describe("JSON string to parse/validate, or object to stringify"),
		pretty: z
			.boolean()
			.optional()
			.describe("Whether to pretty-print the output (for stringify)"),
	}),
	execute: async ({ action, input, pretty = false }) => {
		switch (action) {
			case "parse":
				try {
					const parsed = JSON.parse(input);
					return { success: true, data: parsed };
				} catch (e) {
					return {
						success: false,
						error: e instanceof Error ? e.message : "Parse error",
					};
				}
			case "stringify":
				try {
					const obj = JSON.parse(input);
					const stringified = pretty
						? JSON.stringify(obj, null, 2)
						: JSON.stringify(obj);
					return { success: true, json: stringified };
				} catch (e) {
					return {
						success: false,
						error: e instanceof Error ? e.message : "Stringify error",
					};
				}
			case "validate":
				try {
					JSON.parse(input);
					return { valid: true };
				} catch (e) {
					return {
						valid: false,
						error: e instanceof Error ? e.message : "Invalid JSON",
					};
				}
		}
	},
});

/**
 * String manipulation tool
 */
export const stringTool = tool({
	description:
		"Perform various string manipulation operations like case conversion, trimming, splitting, etc.",
	inputSchema: z.object({
		operation: z
			.enum([
				"uppercase",
				"lowercase",
				"capitalize",
				"trim",
				"split",
				"join",
				"replace",
				"length",
				"reverse",
			])
			.describe("The string operation to perform"),
		input: z.string().describe("The input string"),
		arg: z
			.string()
			.optional()
			.describe(
				"Additional argument (delimiter for split/join, search string for replace)"
			),
		arg2: z.string().optional().describe("Second argument (replacement for replace)"),
	}),
	execute: async ({ operation, input, arg, arg2 }) => {
		switch (operation) {
			case "uppercase":
				return { result: input.toUpperCase() };
			case "lowercase":
				return { result: input.toLowerCase() };
			case "capitalize":
				return {
					result: input.charAt(0).toUpperCase() + input.slice(1).toLowerCase(),
				};
			case "trim":
				return { result: input.trim() };
			case "split":
				return { result: input.split(arg || " ") };
			case "join":
				// Assumes input is a JSON array string
				try {
					const arr = JSON.parse(input);
					if (Array.isArray(arr)) {
						return { result: arr.join(arg || ",") };
					}
					return { error: "Input must be a JSON array" };
				} catch {
					return { error: "Invalid JSON array" };
				}
			case "replace":
				if (!arg) {
					return { error: "Search string (arg) is required for replace" };
				}
				return { result: input.replace(new RegExp(arg, "g"), arg2 || "") };
			case "length":
				return { length: input.length };
			case "reverse":
				return { result: input.split("").reverse().join("") };
		}
	},
});

/**
 * Wait/delay tool for testing async behavior
 */
export const waitTool = tool({
	description:
		"Wait for a specified number of milliseconds. Useful for testing or rate limiting.",
	inputSchema: z.object({
		milliseconds: z
			.number()
			.min(0)
			.max(30000)
			.describe("Number of milliseconds to wait (max 30 seconds)"),
	}),
	execute: async ({ milliseconds }) => {
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
		return { waited: milliseconds, message: `Waited ${milliseconds}ms` };
	},
});

/**
 * Memory/state tool for persisting data across tool calls
 * Returns a tool creator function that maintains its own memory Map
 */
export function createMemoryTool() {
	const memory = new Map<string, unknown>();

	return tool({
		description:
			"Store and retrieve key-value pairs in memory. Useful for persisting data across tool calls within a session.",
		inputSchema: z.object({
			action: z
				.enum(["get", "set", "delete", "list", "clear"])
				.describe("The memory operation to perform"),
			key: z.string().optional().describe("The key to get/set/delete"),
			value: z.unknown().optional().describe("The value to store (for set action)"),
		}),
		execute: async ({ action, key, value }) => {
			switch (action) {
				case "get":
					if (!key) {
						return { error: "Key is required for get action" };
					}
					if (!memory.has(key)) {
						return { found: false, key };
					}
					return { found: true, key, value: memory.get(key) };
				case "set":
					if (!key) {
						return { error: "Key is required for set action" };
					}
					memory.set(key, value);
					return { success: true, key };
				case "delete":
					if (!key) {
						return { error: "Key is required for delete action" };
					}
					const existed = memory.delete(key);
					return { success: true, existed, key };
				case "list":
					return { keys: Array.from(memory.keys()) };
				case "clear":
					memory.clear();
					return { success: true, message: "Memory cleared" };
			}
		},
	});
}

/**
 * All built-in tools as an object for use with v5 Agent
 */
export const builtinTools = {
	calculator: calculatorTool,
	datetime: dateTimeTool,
	json: jsonTool,
	string: stringTool,
	wait: waitTool,
};

/**
 * Create a full set of built-in tools including stateful ones
 */
export function createBuiltinTools() {
	return {
		...builtinTools,
		memory: createMemoryTool(),
	};
}
