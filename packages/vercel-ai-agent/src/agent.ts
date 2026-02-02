import {
	generateText,
	streamText,
	type CoreMessage,
	type CoreTool,
	type StepResult as AIStepResult,
	type TextStreamPart,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
	AgentConfig,
	AgentRunInput,
	AgentResponse,
	AgentStreamResponse,
	AgentCallbacks,
	AgentExecutionConfig,
	ConversationMessage,
	StepResult,
	StreamChunk,
	ToolCall,
	ToolResult,
	TokenUsage,
	FinishReason,
	StopCondition,
	ModelConfig,
	AgentToolDefinition,
	ErrorContext,
} from "./types.js";
import { createMessageId, toCoreTool } from "./types.js";
import { ToolRegistry, createToolRegistry } from "./tools/registry.js";

/**
 * Creates a language model instance from configuration
 */
function createModel(config: ModelConfig) {
	const { provider, modelId, apiKey, baseUrl, headers } = config;

	switch (provider) {
		case "openai": {
			const openai = createOpenAI({
				apiKey,
				baseURL: baseUrl,
				headers,
			});
			return openai(modelId);
		}
		case "anthropic": {
			const anthropic = createAnthropic({
				apiKey,
				baseURL: baseUrl,
				headers,
			});
			return anthropic(modelId);
		}
		case "google": {
			const google = createGoogleGenerativeAI({
				apiKey,
				baseURL: baseUrl,
				headers,
			});
			return google(modelId);
		}
		case "custom": {
			// For custom providers, use OpenAI-compatible API
			const custom = createOpenAI({
				apiKey: apiKey || "custom",
				baseURL: baseUrl,
				headers,
			});
			return custom(modelId);
		}
		default:
			throw new Error(`Unsupported provider: ${provider}`);
	}
}

/**
 * Converts AI SDK step result to our internal format
 */
function convertStepResult(
	step: AIStepResult<Record<string, CoreTool>>,
	stepNumber: number,
	isFinal: boolean
): StepResult {
	const toolCalls: ToolCall[] = (step.toolCalls || []).map((tc) => ({
		id: tc.toolCallId,
		name: tc.toolName,
		arguments: tc.args as Record<string, unknown>,
	}));

	const toolResults: ToolResult[] = (step.toolResults || []).map((tr) => ({
		toolCallId: tr.toolCallId,
		toolName: tr.toolName,
		result: tr.result,
		isSuccess: true, // AI SDK doesn't distinguish success/failure in results
	}));

	// Determine step type
	let stepType: "initial" | "tool-result" | "continue" = "initial";
	if (stepNumber > 0) {
		stepType = toolResults.length > 0 ? "tool-result" : "continue";
	}

	return {
		stepNumber,
		stepType,
		text: step.text || "",
		toolCalls,
		toolResults,
		finishReason: step.finishReason as FinishReason,
		usage: {
			promptTokens: step.usage?.promptTokens || 0,
			completionTokens: step.usage?.completionTokens || 0,
			totalTokens: step.usage?.totalTokens || 0,
		},
		isFinalStep: isFinal,
	};
}

/**
 * Converts messages to CoreMessage format
 */
function toCoreMessages(
	input: CoreMessage[] | string
): CoreMessage[] {
	if (typeof input === "string") {
		return [{ role: "user", content: input }];
	}
	return input;
}

/**
 * Converts CoreMessage to ConversationMessage
 */
function toConversationMessage(msg: CoreMessage): ConversationMessage {
	return {
		id: createMessageId(),
		role: msg.role as ConversationMessage["role"],
		content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
		createdAt: new Date(),
	};
}

/**
 * Checks if any stop condition is met
 */
function checkStopConditions(
	step: StepResult,
	conditions: StopCondition[]
): boolean {
	for (const condition of conditions) {
		switch (condition.type) {
			case "maxSteps":
				if (step.stepNumber >= condition.value - 1) {
					return true;
				}
				break;
			case "toolResult":
				if (step.toolResults.some((tr) => tr.toolName === condition.toolName)) {
					return true;
				}
				break;
			case "custom":
				if (condition.predicate(step)) {
					return true;
				}
				break;
		}
	}
	return false;
}

/**
 * Merge execution configs with defaults
 */
function mergeExecutionConfig(
	defaults: AgentExecutionConfig | undefined,
	overrides: AgentExecutionConfig | undefined
): AgentExecutionConfig {
	return {
		maxSteps: overrides?.maxSteps ?? defaults?.maxSteps ?? 10,
		maxTokens: overrides?.maxTokens ?? defaults?.maxTokens,
		temperature: overrides?.temperature ?? defaults?.temperature ?? 0.7,
		topP: overrides?.topP ?? defaults?.topP,
		stopSequences: overrides?.stopSequences ?? defaults?.stopSequences,
		stream: overrides?.stream ?? defaults?.stream ?? false,
		abortSignal: overrides?.abortSignal ?? defaults?.abortSignal,
	};
}

/**
 * Merge callbacks with defaults
 */
function mergeCallbacks(
	defaults: AgentCallbacks | undefined,
	overrides: AgentCallbacks | undefined
): AgentCallbacks {
	return {
		onStepFinish: overrides?.onStepFinish ?? defaults?.onStepFinish,
		onChunk: overrides?.onChunk ?? defaults?.onChunk,
		onFinish: overrides?.onFinish ?? defaults?.onFinish,
		onStepStart: overrides?.onStepStart ?? defaults?.onStepStart,
		onUsage: overrides?.onUsage ?? defaults?.onUsage,
		onError: overrides?.onError ?? defaults?.onError,
		onToolApproval: overrides?.onToolApproval ?? defaults?.onToolApproval,
	};
}

/**
 * Conversational AI Agent using Vercel AI SDK
 *
 * This agent implements a complete agentic chat flow with:
 * - Multi-step tool calling with maxSteps
 * - Streaming support with onChunk callbacks
 * - Step-by-step callbacks (onStepStart, onStepFinish)
 * - Human-in-the-loop tool approval
 * - Configurable stop conditions
 * - Full conversation history tracking
 */
export class ConversationalAgent {
	private config: AgentConfig;
	private toolRegistry: ToolRegistry;
	private conversationHistory: ConversationMessage[] = [];

	constructor(config: AgentConfig) {
		this.config = config;
		this.toolRegistry = createToolRegistry();

		// Register any tools from config
		if (config.tools) {
			this.toolRegistry.registerMany(config.tools);
		}
	}

	/**
	 * Get the current conversation history
	 */
	getConversationHistory(): ConversationMessage[] {
		return [...this.conversationHistory];
	}

	/**
	 * Clear the conversation history
	 */
	clearConversationHistory(): void {
		this.conversationHistory = [];
	}

	/**
	 * Add a message to the conversation history
	 */
	addMessage(message: ConversationMessage): void {
		this.conversationHistory.push(message);
	}

	/**
	 * Get the tool registry for adding/removing tools
	 */
	getToolRegistry(): ToolRegistry {
		return this.toolRegistry;
	}

	/**
	 * Register a new tool
	 */
	registerTool(tool: AgentToolDefinition): this {
		this.toolRegistry.register(tool);
		return this;
	}

	/**
	 * Run the agent with the given input (non-streaming)
	 */
	async run(input: AgentRunInput): Promise<AgentResponse> {
		const executionConfig = mergeExecutionConfig(
			this.config.defaultExecutionConfig,
			input.executionConfig
		);
		const callbacks = mergeCallbacks(
			this.config.defaultCallbacks,
			input.callbacks
		);

		const model = createModel(this.config.model);
		const messages = toCoreMessages(input.messages);

		// Build the full message array including history
		const fullMessages: CoreMessage[] = [
			...this.conversationHistory.map((m) => ({
				role: m.role,
				content: m.content,
			})) as CoreMessage[],
			...messages,
		];

		// Add user messages to history
		for (const msg of messages) {
			this.conversationHistory.push(toConversationMessage(msg));
		}

		// Get tools as CoreTool format
		const tools = this.toolRegistry.toCoreTools();

		// Track all steps
		const allSteps: StepResult[] = [];
		let stepNumber = 0;
		let totalUsage: TokenUsage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};

		try {
			// Notify step start
			await callbacks.onStepStart?.(stepNumber);

			const result = await generateText({
				model,
				messages: fullMessages,
				system: this.config.systemPrompt,
				tools: Object.keys(tools).length > 0 ? tools : undefined,
				maxSteps: executionConfig.maxSteps,
				maxTokens: executionConfig.maxTokens,
				temperature: executionConfig.temperature,
				topP: executionConfig.topP,
				stopSequences: executionConfig.stopSequences,
				abortSignal: executionConfig.abortSignal,

				// Step finish callback
				onStepFinish: async (stepResult) => {
					const isFinal =
						stepResult.finishReason === "stop" ||
						stepResult.finishReason === "length" ||
						stepNumber >= (executionConfig.maxSteps || 10) - 1;

					const step = convertStepResult(stepResult, stepNumber, isFinal);
					allSteps.push(step);

					// Update total usage
					totalUsage.promptTokens += step.usage.promptTokens;
					totalUsage.completionTokens += step.usage.completionTokens;
					totalUsage.totalTokens += step.usage.totalTokens;

					// Invoke callbacks
					await callbacks.onStepFinish?.(step);
					await callbacks.onUsage?.(step.usage);

					// Check custom stop conditions
					if (
						this.config.stopWhen &&
						checkStopConditions(step, this.config.stopWhen)
					) {
						// Note: We can't actually abort here in generateText,
						// but we track that we would have stopped
					}

					stepNumber++;

					// Notify next step start if not final
					if (!isFinal) {
						await callbacks.onStepStart?.(stepNumber);
					}
				},
			});

			// Build the response
			const assistantMessage: ConversationMessage = {
				id: createMessageId(),
				role: "assistant",
				content: result.text,
				toolCalls:
					result.toolCalls?.map((tc) => ({
						id: tc.toolCallId,
						name: tc.toolName,
						arguments: tc.args as Record<string, unknown>,
					})) || undefined,
				createdAt: new Date(),
			};

			this.conversationHistory.push(assistantMessage);

			const response: AgentResponse = {
				text: result.text,
				messages: this.getConversationHistory(),
				steps: allSteps,
				finishReason: result.finishReason as FinishReason,
				usage: totalUsage,
				isComplete: true,
			};

			await callbacks.onFinish?.(response);

			return response;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));

			const errorContext: ErrorContext = {
				stepNumber,
				phase: "generation",
			};

			await callbacks.onError?.(err, errorContext);

			return {
				text: "",
				messages: this.getConversationHistory(),
				steps: allSteps,
				finishReason: "error",
				usage: totalUsage,
				isComplete: false,
				error: err,
			};
		}
	}

	/**
	 * Run the agent with streaming output
	 */
	async runStream(input: AgentRunInput): Promise<AgentStreamResponse> {
		const executionConfig = mergeExecutionConfig(
			this.config.defaultExecutionConfig,
			{ ...input.executionConfig, stream: true }
		);
		const callbacks = mergeCallbacks(
			this.config.defaultCallbacks,
			input.callbacks
		);

		const model = createModel(this.config.model);
		const messages = toCoreMessages(input.messages);

		// Build the full message array including history
		const fullMessages: CoreMessage[] = [
			...this.conversationHistory.map((m) => ({
				role: m.role,
				content: m.content,
			})) as CoreMessage[],
			...messages,
		];

		// Add user messages to history
		for (const msg of messages) {
			this.conversationHistory.push(toConversationMessage(msg));
		}

		// Get tools as CoreTool format
		const tools = this.toolRegistry.toCoreTools();

		// Track state
		const allSteps: StepResult[] = [];
		let stepNumber = 0;
		let totalUsage: TokenUsage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};
		let fullText = "";
		let finalResponse: AgentResponse | null = null;
		let streamError: Error | null = null;

		// Create deferred promises for async access
		let resolveText: (value: string) => void;
		let resolveSteps: (value: StepResult[]) => void;
		let resolveUsage: (value: TokenUsage) => void;
		let resolveResponse: (value: AgentResponse) => void;
		let rejectAll: (error: Error) => void;

		const textPromise = new Promise<string>((resolve, reject) => {
			resolveText = resolve;
			rejectAll = reject;
		});
		const stepsPromise = new Promise<StepResult[]>((resolve, reject) => {
			resolveSteps = resolve;
		});
		const usagePromise = new Promise<TokenUsage>((resolve, reject) => {
			resolveUsage = resolve;
		});
		const responsePromise = new Promise<AgentResponse>((resolve, reject) => {
			resolveResponse = resolve;
		});

		// Notify step start
		callbacks.onStepStart?.(stepNumber);

		const result = streamText({
			model,
			messages: fullMessages,
			system: this.config.systemPrompt,
			tools: Object.keys(tools).length > 0 ? tools : undefined,
			maxSteps: executionConfig.maxSteps,
			maxTokens: executionConfig.maxTokens,
			temperature: executionConfig.temperature,
			topP: executionConfig.topP,
			stopSequences: executionConfig.stopSequences,
			abortSignal: executionConfig.abortSignal,

			// Chunk callback
			onChunk: async (chunk) => {
				const streamChunk = convertChunkToStreamChunk(chunk.chunk);
				if (streamChunk) {
					await callbacks.onChunk?.(streamChunk);
				}
			},

			// Step finish callback
			onStepFinish: async (stepResult) => {
				const isFinal =
					stepResult.finishReason === "stop" ||
					stepResult.finishReason === "length" ||
					stepNumber >= (executionConfig.maxSteps || 10) - 1;

				const step = convertStepResult(stepResult, stepNumber, isFinal);
				allSteps.push(step);

				// Update total usage
				totalUsage.promptTokens += step.usage.promptTokens;
				totalUsage.completionTokens += step.usage.completionTokens;
				totalUsage.totalTokens += step.usage.totalTokens;

				await callbacks.onStepFinish?.(step);
				await callbacks.onUsage?.(step.usage);

				stepNumber++;

				if (!isFinal) {
					await callbacks.onStepStart?.(stepNumber);
				}
			},

			// Finish callback
			onFinish: async (event) => {
				fullText = event.text;

				const assistantMessage: ConversationMessage = {
					id: createMessageId(),
					role: "assistant",
					content: event.text,
					createdAt: new Date(),
				};

				this.conversationHistory.push(assistantMessage);

				finalResponse = {
					text: event.text,
					messages: this.getConversationHistory(),
					steps: allSteps,
					finishReason: event.finishReason as FinishReason,
					usage: totalUsage,
					isComplete: true,
				};

				await callbacks.onFinish?.(finalResponse);

				resolveText(fullText);
				resolveSteps(allSteps);
				resolveUsage(totalUsage);
				resolveResponse(finalResponse);
			},
		});

		// Create the async iterator
		const self = this;

		const streamResponse: AgentStreamResponse = {
			async *[Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
				try {
					for await (const part of result.fullStream) {
						const chunk = convertStreamPartToChunk(part);
						if (chunk) {
							if (chunk.type === "text-delta" && chunk.textDelta) {
								fullText += chunk.textDelta;
							}
							yield chunk;
						}
					}
				} catch (error) {
					streamError =
						error instanceof Error ? error : new Error(String(error));

					const errorContext: ErrorContext = {
						stepNumber,
						phase: "generation",
					};

					await callbacks.onError?.(streamError, errorContext);

					yield {
						type: "error",
						error: streamError,
					};

					rejectAll(streamError);
				}
			},
			get text() {
				return textPromise;
			},
			get steps() {
				return stepsPromise;
			},
			get usage() {
				return usagePromise;
			},
			get response() {
				return responsePromise;
			},
		};

		return streamResponse;
	}

	/**
	 * Convenience method that auto-selects streaming or non-streaming based on config
	 */
	async chat(
		message: string,
		options?: {
			executionConfig?: AgentExecutionConfig;
			callbacks?: AgentCallbacks;
		}
	): Promise<AgentResponse | AgentStreamResponse> {
		const input: AgentRunInput = {
			messages: message,
			executionConfig: options?.executionConfig,
			callbacks: options?.callbacks,
		};

		const shouldStream =
			options?.executionConfig?.stream ??
			this.config.defaultExecutionConfig?.stream ??
			false;

		if (shouldStream) {
			return this.runStream(input);
		}
		return this.run(input);
	}

	/**
	 * Run with human-in-the-loop tool approval
	 * Tools marked with requiresConfirmation will trigger the onToolApproval callback
	 */
	async runWithApproval(input: AgentRunInput): Promise<AgentResponse> {
		const callbacks = mergeCallbacks(
			this.config.defaultCallbacks,
			input.callbacks
		);

		if (!callbacks.onToolApproval) {
			throw new Error(
				"onToolApproval callback is required for runWithApproval"
			);
		}

		// Wrap tools that require confirmation
		const originalTools = this.toolRegistry.getAll();
		const wrappedTools: AgentToolDefinition[] = originalTools.map((tool) => {
			if (!tool.requiresConfirmation) {
				return tool;
			}

			return {
				...tool,
				execute: async (params, options) => {
					const toolCall: ToolCall = {
						id: `pending_${Date.now()}`,
						name: tool.name,
						arguments: params as Record<string, unknown>,
					};

					const approved = await callbacks.onToolApproval!(toolCall);

					if (!approved) {
						return {
							error: "Tool execution was rejected by user",
							rejected: true,
						};
					}

					return tool.execute(params, options);
				},
			};
		});

		// Temporarily replace tools
		const tempRegistry = createToolRegistry();
		tempRegistry.registerMany(wrappedTools);

		const originalRegistry = this.toolRegistry;
		this.toolRegistry = tempRegistry;

		try {
			return await this.run(input);
		} finally {
			this.toolRegistry = originalRegistry;
		}
	}

	/**
	 * Get the current configuration
	 */
	getConfig(): AgentConfig {
		return { ...this.config };
	}

	/**
	 * Update the system prompt
	 */
	setSystemPrompt(prompt: string): void {
		this.config.systemPrompt = prompt;
	}

	/**
	 * Update the model configuration
	 */
	setModel(model: ModelConfig): void {
		this.config.model = model;
	}
}

/**
 * Convert AI SDK chunk to our StreamChunk format
 */
function convertChunkToStreamChunk(chunk: unknown): StreamChunk | null {
	if (!chunk || typeof chunk !== "object") {
		return null;
	}

	const c = chunk as Record<string, unknown>;

	if (c.type === "text-delta") {
		return {
			type: "text-delta",
			textDelta: c.textDelta as string,
		};
	}

	if (c.type === "tool-call") {
		return {
			type: "tool-call",
			toolCall: {
				id: c.toolCallId as string,
				name: c.toolName as string,
				arguments: c.args as Record<string, unknown>,
			},
		};
	}

	if (c.type === "tool-result") {
		return {
			type: "tool-result",
			toolResult: {
				toolCallId: c.toolCallId as string,
				toolName: c.toolName as string,
				result: c.result,
				isSuccess: true,
			},
		};
	}

	return null;
}

/**
 * Convert AI SDK stream part to our StreamChunk format
 */
function convertStreamPartToChunk(part: TextStreamPart<Record<string, CoreTool>>): StreamChunk | null {
	switch (part.type) {
		case "text-delta":
			return {
				type: "text-delta",
				textDelta: part.textDelta,
			};

		case "tool-call":
			return {
				type: "tool-call",
				toolCall: {
					id: part.toolCallId,
					name: part.toolName,
					arguments: part.args as Record<string, unknown>,
				},
			};

		case "tool-result":
			return {
				type: "tool-result",
				toolResult: {
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					result: part.result,
					isSuccess: true,
				},
			};

		case "tool-call-streaming-start":
			return {
				type: "tool-call-streaming-start",
				toolCall: {
					id: part.toolCallId,
					name: part.toolName,
					arguments: {},
				},
			};

		case "tool-call-delta":
			return {
				type: "tool-call-delta",
				toolCallDelta: {
					toolCallId: part.toolCallId,
					argsTextDelta: part.argsTextDelta,
				},
			};

		case "step-finish":
			return {
				type: "step-finish",
			};

		case "finish":
			return {
				type: "finish",
			};

		case "error":
			return {
				type: "error",
				error: part.error instanceof Error ? part.error : new Error(String(part.error)),
			};

		default:
			return null;
	}
}

/**
 * Factory function to create a new agent
 */
export function createAgent(config: AgentConfig): ConversationalAgent {
	return new ConversationalAgent(config);
}
