import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	StreamProcessor,
	createStreamProcessor,
	transformStream,
	filterStreamByType,
	collectStreamText,
	batchTextDeltas,
	addTimingInfo,
	toReadableStream,
	fromReadableStream,
} from "./streaming.js";
import type { StreamChunk, StepResult } from "./types.js";

describe("StreamProcessor", () => {
	let processor: StreamProcessor;

	beforeEach(() => {
		processor = createStreamProcessor({
			textBufferSize: 5,
			textDebounceMs: 10,
		});
	});

	describe("text delta processing", () => {
		it("should accumulate text deltas", async () => {
			await processor.processChunk({ type: "text-delta", textDelta: "Hello" });
			await processor.processChunk({ type: "text-delta", textDelta: " World" });

			// Force flush
			await processor.processChunk({ type: "finish" });

			const state = processor.getState();
			expect(state.text).toBe("Hello World");
		});

		it("should emit text events when buffer is full", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			// Buffer size is 5, so this should trigger a flush
			await processor.processChunk({ type: "text-delta", textDelta: "12345" });

			expect(events.some((e: { type?: string }) => e.type === "text")).toBe(true);
		});
	});

	describe("tool call processing", () => {
		it("should emit tool call start event", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			await processor.processChunk({
				type: "tool-call-streaming-start",
				toolCall: { id: "tc1", name: "test_tool", arguments: {} },
			});

			expect(events).toContainEqual({
				type: "tool-call-start",
				toolCall: { id: "tc1", name: "test_tool", arguments: {} },
			});
		});

		it("should emit tool call progress", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			await processor.processChunk({
				type: "tool-call-delta",
				toolCallDelta: { toolCallId: "tc1", argsTextDelta: '{"key":' },
			});

			expect(events).toContainEqual({
				type: "tool-call-progress",
				toolCallId: "tc1",
				argsDelta: '{"key":',
			});
		});

		it("should emit tool call complete", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			await processor.processChunk({
				type: "tool-call",
				toolCall: { id: "tc1", name: "test_tool", arguments: { key: "value" } },
			});

			expect(events).toContainEqual({
				type: "tool-call-complete",
				toolCall: { id: "tc1", name: "test_tool", arguments: { key: "value" } },
			});
		});
	});

	describe("tool result processing", () => {
		it("should track tool results", async () => {
			const toolResult = {
				toolCallId: "tc1",
				toolName: "test_tool",
				result: { output: "success" },
				isSuccess: true,
			};

			await processor.processChunk({
				type: "tool-result",
				toolResult,
			});

			const state = processor.getState();
			expect(state.toolResults).toContainEqual(toolResult);
		});

		it("should emit tool result event", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			const toolResult = {
				toolCallId: "tc1",
				toolName: "test_tool",
				result: { output: "success" },
				isSuccess: true,
			};

			await processor.processChunk({
				type: "tool-result",
				toolResult,
			});

			expect(events).toContainEqual({
				type: "tool-result",
				toolResult,
			});
		});
	});

	describe("step processing", () => {
		it("should track steps and usage", async () => {
			const stepResult: StepResult = {
				stepNumber: 0,
				stepType: "initial",
				text: "Hello",
				toolCalls: [],
				toolResults: [],
				finishReason: "stop",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				isFinalStep: true,
			};

			await processor.processChunk({
				type: "step-finish",
				stepResult,
			});

			const state = processor.getState();
			expect(state.steps).toContainEqual(stepResult);
			expect(state.usage.totalTokens).toBe(15);
		});
	});

	describe("event handlers", () => {
		it("should support multiple handlers", async () => {
			const handler1 = vi.fn();
			const handler2 = vi.fn();

			processor.on(handler1);
			processor.on(handler2);

			await processor.processChunk({ type: "text-delta", textDelta: "12345" });

			expect(handler1).toHaveBeenCalled();
			expect(handler2).toHaveBeenCalled();
		});

		it("should allow removing handlers", async () => {
			const handler = vi.fn();
			const unsubscribe = processor.on(handler);

			unsubscribe();

			await processor.processChunk({ type: "text-delta", textDelta: "12345" });

			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe("error handling", () => {
		it("should track errors", async () => {
			const error = new Error("Test error");

			await processor.processChunk({
				type: "error",
				error,
			});

			const state = processor.getState();
			expect(state.error).toBe(error);
		});

		it("should emit error event", async () => {
			const events: unknown[] = [];
			processor.on((event) => {
				events.push(event);
			});

			const error = new Error("Test error");

			await processor.processChunk({
				type: "error",
				error,
			});

			expect(events).toContainEqual({
				type: "error",
				error,
			});
		});
	});

	describe("reset", () => {
		it("should reset all state", async () => {
			await processor.processChunk({ type: "text-delta", textDelta: "Hello" });
			await processor.processChunk({ type: "finish" });

			processor.reset();

			const state = processor.getState();
			expect(state.text).toBe("");
			expect(state.steps).toHaveLength(0);
			expect(state.isComplete).toBe(false);
		});
	});
});

describe("Stream utilities", () => {
	async function* createTestStream(): AsyncIterable<StreamChunk> {
		yield { type: "text-delta", textDelta: "Hello" };
		yield { type: "text-delta", textDelta: " " };
		yield { type: "text-delta", textDelta: "World" };
		yield {
			type: "tool-call",
			toolCall: { id: "tc1", name: "test", arguments: {} },
		};
		yield { type: "finish" };
	}

	describe("transformStream", () => {
		it("should transform chunks", async () => {
			const transformed = transformStream(createTestStream(), (chunk) => {
				if (chunk.type === "text-delta" && chunk.textDelta) {
					return { ...chunk, textDelta: chunk.textDelta.toUpperCase() };
				}
				return chunk;
			});

			const chunks: StreamChunk[] = [];
			for await (const chunk of transformed) {
				chunks.push(chunk);
			}

			expect(chunks[0].textDelta).toBe("HELLO");
		});

		it("should filter out null results", async () => {
			const transformed = transformStream(createTestStream(), (chunk) => {
				if (chunk.type === "text-delta") {
					return null;
				}
				return chunk;
			});

			const chunks: StreamChunk[] = [];
			for await (const chunk of transformed) {
				chunks.push(chunk);
			}

			expect(chunks.every((c) => c.type !== "text-delta")).toBe(true);
		});

		it("should expand to multiple chunks", async () => {
			const transformed = transformStream(createTestStream(), (chunk) => {
				if (chunk.type === "text-delta" && chunk.textDelta === "Hello") {
					return [
						{ type: "text-delta" as const, textDelta: "Hi" },
						{ type: "text-delta" as const, textDelta: "!" },
					];
				}
				return chunk;
			});

			const chunks: StreamChunk[] = [];
			for await (const chunk of transformed) {
				chunks.push(chunk);
			}

			expect(chunks[0].textDelta).toBe("Hi");
			expect(chunks[1].textDelta).toBe("!");
		});
	});

	describe("filterStreamByType", () => {
		it("should filter chunks by type", async () => {
			const filtered = filterStreamByType(createTestStream(), ["text-delta"]);

			const chunks: StreamChunk[] = [];
			for await (const chunk of filtered) {
				chunks.push(chunk);
			}

			expect(chunks.every((c) => c.type === "text-delta")).toBe(true);
			expect(chunks.length).toBe(3);
		});

		it("should allow multiple types", async () => {
			const filtered = filterStreamByType(createTestStream(), [
				"text-delta",
				"tool-call",
			]);

			const chunks: StreamChunk[] = [];
			for await (const chunk of filtered) {
				chunks.push(chunk);
			}

			expect(chunks.length).toBe(4);
		});
	});

	describe("collectStreamText", () => {
		it("should collect all text deltas", async () => {
			const text = await collectStreamText(createTestStream());
			expect(text).toBe("Hello World");
		});
	});

	describe("batchTextDeltas", () => {
		it("should batch text deltas", async () => {
			async function* manyDeltas(): AsyncIterable<StreamChunk> {
				for (let i = 0; i < 100; i++) {
					yield { type: "text-delta", textDelta: "a" };
				}
				yield { type: "finish" };
			}

			const batched = batchTextDeltas(manyDeltas(), { batchSize: 10 });

			const chunks: StreamChunk[] = [];
			for await (const chunk of batched) {
				chunks.push(chunk);
			}

			// Should have fewer chunks due to batching
			const textChunks = chunks.filter((c) => c.type === "text-delta");
			expect(textChunks.length).toBeLessThan(100);

			// But total text should be the same
			const totalText = textChunks.reduce(
				(acc, c) => acc + (c.textDelta || ""),
				""
			);
			expect(totalText).toBe("a".repeat(100));
		});

		it("should flush before non-text chunks", async () => {
			async function* mixedStream(): AsyncIterable<StreamChunk> {
				yield { type: "text-delta", textDelta: "aaa" };
				yield {
					type: "tool-call",
					toolCall: { id: "tc1", name: "test", arguments: {} },
				};
				yield { type: "text-delta", textDelta: "bbb" };
			}

			const batched = batchTextDeltas(mixedStream(), { batchSize: 100 });

			const chunks: StreamChunk[] = [];
			for await (const chunk of batched) {
				chunks.push(chunk);
			}

			// Text should be flushed before tool call
			expect(chunks[0].type).toBe("text-delta");
			expect(chunks[1].type).toBe("tool-call");
		});
	});

	describe("addTimingInfo", () => {
		it("should add timestamp and elapsed time", async () => {
			const timed = addTimingInfo(createTestStream());

			const chunks: Array<StreamChunk & { timestamp: number; elapsed: number }> =
				[];
			for await (const chunk of timed) {
				chunks.push(chunk);
			}

			expect(chunks[0].timestamp).toBeDefined();
			expect(chunks[0].elapsed).toBeDefined();
			expect(chunks[0].elapsed).toBeGreaterThanOrEqual(0);

			// Later chunks should have larger elapsed times
			expect(chunks[chunks.length - 1].elapsed).toBeGreaterThanOrEqual(
				chunks[0].elapsed
			);
		});
	});

	describe("ReadableStream conversion", () => {
		it("should convert async iterable to ReadableStream", async () => {
			const stream = toReadableStream(createTestStream());

			expect(stream).toBeInstanceOf(ReadableStream);

			const reader = stream.getReader();
			const { value, done } = await reader.read();

			expect(done).toBe(false);
			expect(value?.type).toBe("text-delta");

			reader.releaseLock();
		});

		it("should convert ReadableStream back to async iterable", async () => {
			const stream = toReadableStream(createTestStream());
			const iterable = fromReadableStream(stream);

			const chunks: StreamChunk[] = [];
			for await (const chunk of iterable) {
				chunks.push(chunk);
			}

			expect(chunks.length).toBe(5);
			expect(chunks[0].type).toBe("text-delta");
		});
	});
});
