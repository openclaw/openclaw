import type {
	StreamChunk,
	StreamChunkType,
	StepResult,
	ToolCall,
	ToolResult,
	TokenUsage,
	AgentResponse,
} from "./types.js";

/**
 * Options for stream processing
 */
export interface StreamProcessorOptions {
	/** Buffer size for text delta batching */
	textBufferSize?: number;
	/** Debounce delay for text chunks (ms) */
	textDebounceMs?: number;
	/** Whether to emit tool call streaming events */
	emitToolCallStreaming?: boolean;
}

/**
 * Stream state tracking
 */
export interface StreamState {
	/** Full accumulated text */
	text: string;
	/** Current step number */
	stepNumber: number;
	/** Accumulated steps */
	steps: StepResult[];
	/** Pending tool calls being streamed */
	pendingToolCalls: Map<string, Partial<ToolCall>>;
	/** Completed tool results */
	toolResults: ToolResult[];
	/** Total token usage */
	usage: TokenUsage;
	/** Whether streaming is complete */
	isComplete: boolean;
	/** Error if any */
	error?: Error;
}

/**
 * Stream event types for external consumers
 */
export type StreamEvent =
	| { type: "text"; text: string; delta: string }
	| { type: "tool-call-start"; toolCall: ToolCall }
	| { type: "tool-call-progress"; toolCallId: string; argsDelta: string }
	| { type: "tool-call-complete"; toolCall: ToolCall }
	| { type: "tool-result"; toolResult: ToolResult }
	| { type: "step-complete"; step: StepResult }
	| { type: "complete"; response: AgentResponse }
	| { type: "error"; error: Error };

/**
 * Callback for stream events
 */
export type StreamEventHandler = (event: StreamEvent) => void | Promise<void>;

/**
 * Processes and transforms stream chunks
 */
export class StreamProcessor {
	private state: StreamState;
	private options: Required<StreamProcessorOptions>;
	private textBuffer: string = "";
	private textBufferTimeout: ReturnType<typeof setTimeout> | null = null;
	private eventHandlers: StreamEventHandler[] = [];

	constructor(options: StreamProcessorOptions = {}) {
		this.options = {
			textBufferSize: options.textBufferSize ?? 10,
			textDebounceMs: options.textDebounceMs ?? 50,
			emitToolCallStreaming: options.emitToolCallStreaming ?? true,
		};

		this.state = {
			text: "",
			stepNumber: 0,
			steps: [],
			pendingToolCalls: new Map(),
			toolResults: [],
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			isComplete: false,
		};
	}

	/**
	 * Add an event handler
	 */
	on(handler: StreamEventHandler): () => void {
		this.eventHandlers.push(handler);
		return () => {
			const idx = this.eventHandlers.indexOf(handler);
			if (idx >= 0) {
				this.eventHandlers.splice(idx, 1);
			}
		};
	}

	/**
	 * Emit an event to all handlers
	 */
	private async emit(event: StreamEvent): Promise<void> {
		for (const handler of this.eventHandlers) {
			await handler(event);
		}
	}

	/**
	 * Flush the text buffer
	 */
	private async flushTextBuffer(): Promise<void> {
		if (this.textBuffer.length > 0) {
			const delta = this.textBuffer;
			this.state.text += delta;
			this.textBuffer = "";

			await this.emit({
				type: "text",
				text: this.state.text,
				delta,
			});
		}

		if (this.textBufferTimeout) {
			clearTimeout(this.textBufferTimeout);
			this.textBufferTimeout = null;
		}
	}

	/**
	 * Process a stream chunk
	 */
	async processChunk(chunk: StreamChunk): Promise<void> {
		switch (chunk.type) {
			case "text-delta":
				if (chunk.textDelta) {
					this.textBuffer += chunk.textDelta;

					// Flush if buffer is large enough
					if (this.textBuffer.length >= this.options.textBufferSize) {
						await this.flushTextBuffer();
					} else {
						// Set debounce timeout
						if (this.textBufferTimeout) {
							clearTimeout(this.textBufferTimeout);
						}
						this.textBufferTimeout = setTimeout(() => {
							this.flushTextBuffer();
						}, this.options.textDebounceMs);
					}
				}
				break;

			case "tool-call-streaming-start":
				if (chunk.toolCall && this.options.emitToolCallStreaming) {
					this.state.pendingToolCalls.set(chunk.toolCall.id, {
						id: chunk.toolCall.id,
						name: chunk.toolCall.name,
						arguments: {},
					});

					await this.emit({
						type: "tool-call-start",
						toolCall: chunk.toolCall,
					});
				}
				break;

			case "tool-call-delta":
				if (chunk.toolCallDelta && this.options.emitToolCallStreaming) {
					await this.emit({
						type: "tool-call-progress",
						toolCallId: chunk.toolCallDelta.toolCallId,
						argsDelta: chunk.toolCallDelta.argsTextDelta,
					});
				}
				break;

			case "tool-call":
				if (chunk.toolCall) {
					// Remove from pending if it was being streamed
					this.state.pendingToolCalls.delete(chunk.toolCall.id);

					await this.emit({
						type: "tool-call-complete",
						toolCall: chunk.toolCall,
					});
				}
				break;

			case "tool-result":
				if (chunk.toolResult) {
					this.state.toolResults.push(chunk.toolResult);

					await this.emit({
						type: "tool-result",
						toolResult: chunk.toolResult,
					});
				}
				break;

			case "step-finish":
				if (chunk.stepResult) {
					this.state.steps.push(chunk.stepResult);
					this.state.stepNumber = chunk.stepResult.stepNumber + 1;

					// Update usage
					this.state.usage.promptTokens += chunk.stepResult.usage.promptTokens;
					this.state.usage.completionTokens +=
						chunk.stepResult.usage.completionTokens;
					this.state.usage.totalTokens += chunk.stepResult.usage.totalTokens;

					await this.emit({
						type: "step-complete",
						step: chunk.stepResult,
					});
				}
				break;

			case "finish":
				// Flush any remaining text
				await this.flushTextBuffer();
				this.state.isComplete = true;
				break;

			case "error":
				if (chunk.error) {
					this.state.error = chunk.error;
					await this.emit({
						type: "error",
						error: chunk.error,
					});
				}
				break;
		}
	}

	/**
	 * Process multiple chunks
	 */
	async processChunks(chunks: StreamChunk[]): Promise<void> {
		for (const chunk of chunks) {
			await this.processChunk(chunk);
		}
	}

	/**
	 * Complete the stream and emit final event
	 */
	async complete(response: AgentResponse): Promise<void> {
		await this.flushTextBuffer();
		this.state.isComplete = true;

		await this.emit({
			type: "complete",
			response,
		});
	}

	/**
	 * Get current state
	 */
	getState(): Readonly<StreamState> {
		return { ...this.state };
	}

	/**
	 * Reset the processor
	 */
	reset(): void {
		if (this.textBufferTimeout) {
			clearTimeout(this.textBufferTimeout);
			this.textBufferTimeout = null;
		}

		this.textBuffer = "";
		this.state = {
			text: "",
			stepNumber: 0,
			steps: [],
			pendingToolCalls: new Map(),
			toolResults: [],
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			isComplete: false,
		};
	}
}

/**
 * Creates an async iterable that transforms chunks
 */
export async function* transformStream(
	source: AsyncIterable<StreamChunk>,
	transform: (chunk: StreamChunk) => StreamChunk | StreamChunk[] | null
): AsyncIterable<StreamChunk> {
	for await (const chunk of source) {
		const result = transform(chunk);
		if (result === null) {
			continue;
		}
		if (Array.isArray(result)) {
			for (const r of result) {
				yield r;
			}
		} else {
			yield result;
		}
	}
}

/**
 * Filters stream chunks by type
 */
export async function* filterStreamByType(
	source: AsyncIterable<StreamChunk>,
	types: StreamChunkType[]
): AsyncIterable<StreamChunk> {
	for await (const chunk of source) {
		if (types.includes(chunk.type)) {
			yield chunk;
		}
	}
}

/**
 * Collects text deltas into full text
 */
export async function collectStreamText(
	source: AsyncIterable<StreamChunk>
): Promise<string> {
	let text = "";
	for await (const chunk of source) {
		if (chunk.type === "text-delta" && chunk.textDelta) {
			text += chunk.textDelta;
		}
	}
	return text;
}

/**
 * Batches text deltas for more efficient processing
 */
export async function* batchTextDeltas(
	source: AsyncIterable<StreamChunk>,
	options: { batchSize?: number; maxWaitMs?: number } = {}
): AsyncIterable<StreamChunk> {
	const batchSize = options.batchSize ?? 50;
	const maxWaitMs = options.maxWaitMs ?? 100;

	let textBuffer = "";
	let lastYield = Date.now();

	for await (const chunk of source) {
		if (chunk.type === "text-delta" && chunk.textDelta) {
			textBuffer += chunk.textDelta;

			const shouldYield =
				textBuffer.length >= batchSize || Date.now() - lastYield >= maxWaitMs;

			if (shouldYield) {
				yield { type: "text-delta", textDelta: textBuffer };
				textBuffer = "";
				lastYield = Date.now();
			}
		} else {
			// Flush text buffer before non-text chunks
			if (textBuffer.length > 0) {
				yield { type: "text-delta", textDelta: textBuffer };
				textBuffer = "";
				lastYield = Date.now();
			}
			yield chunk;
		}
	}

	// Flush remaining text
	if (textBuffer.length > 0) {
		yield { type: "text-delta", textDelta: textBuffer };
	}
}

/**
 * Adds timing information to chunks
 */
export async function* addTimingInfo(
	source: AsyncIterable<StreamChunk>
): AsyncIterable<StreamChunk & { timestamp: number; elapsed: number }> {
	const startTime = Date.now();

	for await (const chunk of source) {
		const now = Date.now();
		yield {
			...chunk,
			timestamp: now,
			elapsed: now - startTime,
		};
	}
}

/**
 * Create a stream processor
 */
export function createStreamProcessor(
	options?: StreamProcessorOptions
): StreamProcessor {
	return new StreamProcessor(options);
}

/**
 * Utility to create a readable stream from an async iterable
 */
export function toReadableStream(
	source: AsyncIterable<StreamChunk>
): ReadableStream<StreamChunk> {
	const iterator = source[Symbol.asyncIterator]();

	return new ReadableStream<StreamChunk>({
		async pull(controller) {
			try {
				const { value, done } = await iterator.next();
				if (done) {
					controller.close();
				} else {
					controller.enqueue(value);
				}
			} catch (error) {
				controller.error(error);
			}
		},
		cancel() {
			iterator.return?.();
		},
	});
}

/**
 * Utility to create an async iterable from a readable stream
 */
export async function* fromReadableStream(
	stream: ReadableStream<StreamChunk>
): AsyncIterable<StreamChunk> {
	const reader = stream.getReader();

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
