import {
	streamText,
	generateText,
	convertToModelMessages,
	type UIMessage,
} from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
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
	TokenUsage,
	FinishReason,
	ModelConfig,
	ErrorContext,
} from "./types.js";
import { createMessageId } from "./types.js";

/**
 * Creates a language model instance from configuration
 */
function createModel(config: ModelConfig) {
	const { provider, modelId, apiKey, baseUrl, headers } = config;

	switch (provider) {
		case "openai": {
			if (apiKey || baseUrl || headers) {
				const customOpenai = createOpenAI({
					apiKey,
					baseURL: baseUrl,
					headers,
				});
				return customOpenai(modelId);
			}
			return openai(modelId);
		}
		case "anthropic": {
			if (apiKey || baseUrl || headers) {
				const customAnthropic = createAnthropic({
					apiKey,
					baseURL: baseUrl,
					headers,
				});
				return customAnthropic(modelId);
			}
			return anthropic(modelId);
		}
		case "google": {
			if (apiKey || baseUrl || headers) {
				const customGoogle = createGoogleGenerativeAI({
					apiKey,
					baseURL: baseUrl,
					headers,
				});
				return customGoogle(modelId);
			}
			return google(modelId);
		}
		case "custom": {
			// For custom providers, use OpenAI-compatible API
			const custom = createOpenAI({
				apiKey: apiKey || "required",
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
 * Convert UIMessage to ConversationMessage
 */
function toConversationMessage(msg: UIMessage): ConversationMessage {
	// Extract text content from parts array
	let content = "";
	if (msg.parts) {
		for (const part of msg.parts) {
			if (part.type === "text") {
				content += part.text;
			}
		}
	}

	return {
		id: msg.id || createMessageId(),
		role: msg.role === "system" ? "system" : msg.role === "user" ? "user" : "assistant",
		content,
		createdAt: new Date(),
	};
}

/**
 * Convert ConversationMessage to UIMessage
 */
function toUIMessage(msg: ConversationMessage): UIMessage {
	return {
		id: msg.id,
		role: msg.role as "user" | "assistant" | "system",
		parts: [{ type: "text", text: msg.content }],
	};
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
 * Conversational AI Agent using Vercel AI SDK v5
 *
 * Uses stable streamText/generateText APIs with custom multi-step loop.
 * Provides:
 * - Multi-step tool calling
 * - Streaming support
 * - Step-by-step callbacks
 * - Full conversation history tracking
 */
export class ConversationalAgent {
	private config: AgentConfig;
	private conversationHistory: ConversationMessage[] = [];
	private tools: Record<string, any>;

	constructor(config: AgentConfig) {
		this.config = config;
		this.tools = config.tools || {};
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
	 * Register a new tool
	 */
	registerTool(name: string, tool: any): this {
		this.tools[name] = tool;
		return this;
	}

	/**
	 * Register multiple tools
	 */
	registerTools(tools: Record<string, any>): this {
		this.tools = { ...this.tools, ...tools };
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

		// Build messages array
		const inputMessages: UIMessage[] =
			typeof input.messages === "string"
				? [{ id: createMessageId(), role: "user", parts: [{ type: "text", text: input.messages }] }]
				: input.messages.map((m) =>
						typeof m === "string"
							? { id: createMessageId(), role: "user" as const, parts: [{ type: "text", text: m }] }
							: m
				  );

		// Add to history
		for (const msg of inputMessages) {
			this.conversationHistory.push(toConversationMessage(msg));
		}

		// Get history as UIMessages
		const historyMessages = this.conversationHistory
			.slice(0, -inputMessages.length)
			.map(toUIMessage);

		// Combine for model input
		const allMessages = [...historyMessages, ...inputMessages];

		// Track state
		const allSteps: StepResult[] = [];
		let stepNumber = 0;
		let totalUsage: TokenUsage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};

		try {
			// Multi-step loop
			let currentMessages = allMessages;
			let shouldContinue = true;

			while (shouldContinue && stepNumber < (executionConfig.maxSteps || 10)) {
				await callbacks.onStepStart?.(stepNumber);

				// Generate with v5 API
				const result = await generateText({
					model: model as any,
					messages: convertToModelMessages(currentMessages),
					system: this.config.systemPrompt,
					tools: Object.keys(this.tools).length > 0 ? this.tools : undefined,
					maxOutputTokens: executionConfig.maxTokens,
					temperature: executionConfig.temperature,
					topP: executionConfig.topP,
					});

				// Build step result
				const step: StepResult = {
					stepNumber,
					stepType: stepNumber === 0 ? "initial" : result.toolCalls.length > 0 ? "tool-result" : "continue",
					text: result.text,
					toolCalls: result.toolCalls.map((tc) => ({
						id: tc.toolCallId,
						name: tc.toolName,
						arguments: tc.input as Record<string, unknown>,
					})),
					toolResults: result.toolResults.map((tr) => ({
						toolCallId: tr.toolCallId,
						toolName: tr.toolName,
						result: tr.output,
						isSuccess: true,
					})),
					finishReason: result.finishReason as FinishReason,
					usage: {
						promptTokens: result.usage.inputTokens || 0,
						completionTokens: result.usage.outputTokens || 0,
						totalTokens: result.usage.totalTokens || 0,
					},
					isFinalStep: result.finishReason === "stop" || result.finishReason === "length",
				};

				allSteps.push(step);

				// Update total usage
				totalUsage.promptTokens += step.usage.promptTokens;
				totalUsage.completionTokens += step.usage.completionTokens;
				totalUsage.totalTokens += step.usage.totalTokens;

				await callbacks.onStepFinish?.(step);
				await callbacks.onUsage?.(step.usage);

				// Check if we should continue
				shouldContinue = result.toolCalls.length > 0 && !step.isFinalStep;

				// Add assistant message to current messages for next iteration
				if (shouldContinue) {
					currentMessages = [
						...currentMessages,
						{
							id: createMessageId(),
							role: "assistant" as const,
							parts: [{ type: "text", text: result.text }],
						},
					];
				}

				stepNumber++;
			}

			// Get final text from last step
			const finalText = allSteps.length > 0 ? allSteps[allSteps.length - 1].text : "";

			// Add assistant response to history
			const assistantMessage: ConversationMessage = {
				id: createMessageId(),
				role: "assistant",
				content: finalText,
				createdAt: new Date(),
			};

			this.conversationHistory.push(assistantMessage);

			const response: AgentResponse = {
				text: finalText,
				messages: this.getConversationHistory(),
				steps: allSteps,
				finishReason: allSteps.length > 0 ? allSteps[allSteps.length - 1].finishReason : "stop",
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

		// Build messages array
		const inputMessages: UIMessage[] =
			typeof input.messages === "string"
				? [{ id: createMessageId(), role: "user", parts: [{ type: "text", text: input.messages }] }]
				: input.messages.map((m) =>
						typeof m === "string"
							? { id: createMessageId(), role: "user" as const, parts: [{ type: "text", text: m }] }
							: m
				  );

		// Add to history
		for (const msg of inputMessages) {
			this.conversationHistory.push(toConversationMessage(msg));
		}

		// Get history as UIMessages
		const historyMessages = this.conversationHistory
			.slice(0, -inputMessages.length)
			.map(toUIMessage);

		// Combine for model input
		const allMessages = [...historyMessages, ...inputMessages];

		// Track state
		const allSteps: StepResult[] = [];
		let stepNumber = 0;
		let totalUsage: TokenUsage = {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		};
		let fullText = "";

		// Capture class instance for use in async iterator
		const self = this;

		// Create deferred promises
		let resolveText: (value: string) => void;
		let resolveSteps: (value: StepResult[]) => void;
		let resolveUsage: (value: TokenUsage) => void;
		let resolveResponse: (value: AgentResponse) => void;
		let rejectAll: (error: Error) => void;

		const textPromise = new Promise<string>((resolve, reject) => {
			resolveText = resolve;
			rejectAll = reject;
		});
		const stepsPromise = new Promise<StepResult[]>((resolve) => {
			resolveSteps = resolve;
		});
		const usagePromise = new Promise<TokenUsage>((resolve) => {
			resolveUsage = resolve;
		});
		const responsePromise = new Promise<AgentResponse>((resolve) => {
			resolveResponse = resolve;
		});

		// Create async iterator for streaming
		const streamResponse: AgentStreamResponse = {
			async *[Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk> {
				try {
					let currentMessages = allMessages;
					let shouldContinue = true;

					while (shouldContinue && stepNumber < (executionConfig.maxSteps || 10)) {
						await callbacks.onStepStart?.(stepNumber);

						// Stream with v5 API
						const result = streamText({
							model: model as any,
							messages: convertToModelMessages(currentMessages),
							system: self.config.systemPrompt,
							tools: Object.keys(self.tools).length > 0 ? self.tools : undefined,
							maxOutputTokens: executionConfig.maxTokens,
							temperature: executionConfig.temperature,
							topP: executionConfig.topP,
									});

						// Stream chunks
						let stepText = "";
						const stepToolCalls: any[] = [];
						const stepToolResults: any[] = [];

						for await (const chunk of result.fullStream) {
							if (chunk.type === "text-delta") {
								const streamChunk: StreamChunk = {
									type: "text-delta",
									textDelta: chunk.text,
								};
								stepText += chunk.text;
								fullText += chunk.text;
								await callbacks.onChunk?.(streamChunk);
								yield streamChunk;
							} else if (chunk.type === "tool-call") {
								stepToolCalls.push(chunk);
								const streamChunk: StreamChunk = {
									type: "tool-call",
									toolCall: {
										id: chunk.toolCallId,
										name: chunk.toolName,
										arguments: chunk.input as Record<string, unknown>,
									},
								};
								await callbacks.onChunk?.(streamChunk);
								yield streamChunk;
							} else if (chunk.type === "tool-result") {
								stepToolResults.push(chunk);
								const streamChunk: StreamChunk = {
									type: "tool-result",
									toolResult: {
										toolCallId: chunk.toolCallId,
										toolName: chunk.toolName,
										result: chunk.output,
										isSuccess: true,
									},
								};
								await callbacks.onChunk?.(streamChunk);
								yield streamChunk;
							}
						}

						// Get final result
						const usage = await result.usage;
						const finishReason = await result.finishReason;

						// Build step result
						const step: StepResult = {
							stepNumber,
							stepType: stepNumber === 0 ? "initial" : stepToolCalls.length > 0 ? "tool-result" : "continue",
							text: stepText,
							toolCalls: stepToolCalls.map((tc) => ({
								id: tc.toolCallId,
								name: tc.toolName,
								arguments: tc.input as Record<string, unknown>,
							})),
							toolResults: stepToolResults.map((tr) => ({
								toolCallId: tr.toolCallId,
								toolName: tr.toolName,
								result: tr.output,
								isSuccess: true,
							})),
							finishReason: finishReason as FinishReason,
							usage: {
								promptTokens: usage.inputTokens || 0,
								completionTokens: usage.outputTokens || 0,
								totalTokens: usage.totalTokens || 0,
							},
							isFinalStep: finishReason === "stop" || finishReason === "length",
						};

						allSteps.push(step);

						// Update total usage
						totalUsage.promptTokens += step.usage.promptTokens;
						totalUsage.completionTokens += step.usage.completionTokens;
						totalUsage.totalTokens += step.usage.totalTokens;

						await callbacks.onStepFinish?.(step);
						await callbacks.onUsage?.(step.usage);

						yield { type: "step-finish" };

						// Check if we should continue
						shouldContinue = stepToolCalls.length > 0 && !step.isFinalStep;

						// Add assistant message for next iteration
						if (shouldContinue) {
							currentMessages = [
								...currentMessages,
								{
									id: createMessageId(),
									role: "assistant" as const,
									parts: [{ type: "text", text: stepText }],
								},
							];
						}

						stepNumber++;
					}

					// Finalize
					yield { type: "finish" };

					const assistantMessage: ConversationMessage = {
						id: createMessageId(),
						role: "assistant",
						content: fullText,
						createdAt: new Date(),
					};

					self.conversationHistory.push(assistantMessage);

					const finalResponse: AgentResponse = {
						text: fullText,
						messages: self.getConversationHistory(),
						steps: allSteps,
						finishReason: allSteps.length > 0 ? allSteps[allSteps.length - 1].finishReason : "stop",
						usage: totalUsage,
						isComplete: true,
					};

					await callbacks.onFinish?.(finalResponse);

					resolveText(fullText);
					resolveSteps(allSteps);
					resolveUsage(totalUsage);
					resolveResponse(finalResponse);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));

					const errorContext: ErrorContext = {
						stepNumber,
						phase: "generation",
					};

					await callbacks.onError?.(err, errorContext);

					yield {
						type: "error",
						error: err,
					};

					rejectAll(err);
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
 * Factory function to create a new agent
 */
export function createAgent(config: AgentConfig): ConversationalAgent {
	return new ConversationalAgent(config);
}
