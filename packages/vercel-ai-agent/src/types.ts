import type { UIMessage } from "ai";
import { z } from "zod";

/**
 * Supported model providers for the agent
 */
export type ModelProvider = "openai" | "anthropic" | "google" | "custom";

/**
 * Model configuration for initializing the agent
 */
export interface ModelConfig {
	provider: ModelProvider;
	modelId: string;
	/**
	 * API key for authentication. Can be:
	 * - A Clawdbrain AI API key (when using Clawdbrain backend)
	 * - A direct provider API key (for testing/development)
	 */
	apiKey?: string;
	/** Base URL for API requests */
	baseUrl?: string;
	/** Custom headers to include in API requests */
	headers?: Record<string, string>;
}

/**
 * Tool parameter schema using Zod
 */
export type ToolParameters = z.ZodObject<z.ZodRawShape>;

/**
 * Legacy tool definition interface.
 * In v5, tools are created using the tool() helper from 'ai' package.
 * This interface is kept for backward compatibility with existing code.
 */
export interface AgentToolDefinition<TParams extends ToolParameters = ToolParameters> {
	/** Unique identifier for the tool */
	name: string;
	/** Human-readable description of what the tool does */
	description: string;
	/** Zod schema defining the tool's input parameters */
	inputSchema: TParams;
	/** Function to execute when the tool is called */
	execute: (params: z.infer<TParams>) => Promise<unknown>;
	/** Optional: Whether this tool requires user confirmation before execution */
	requiresConfirmation?: boolean;
}

/**
 * Message role types
 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * A single message in the conversation
 */
export interface ConversationMessage {
	id: string;
	role: MessageRole;
	content: string;
	/** Tool call information if this is an assistant message with tool calls */
	toolCalls?: ToolCall[];
	/** Tool result if this is a tool message */
	toolResult?: ToolResult;
	/** Timestamp when the message was created */
	createdAt: Date;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Tool call made by the assistant
 */
export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Result from a tool execution
 */
export interface ToolResult {
	toolCallId: string;
	toolName: string;
	result: unknown;
	/** Whether the tool execution was successful */
	isSuccess: boolean;
	/** Error message if the tool failed */
	error?: string;
}

/**
 * Step result from the agent's execution
 */
export interface StepResult {
	/** The step number (0-indexed) */
	stepNumber: number;
	/** Type of step: initial, tool-result, or continue */
	stepType: "initial" | "tool-result" | "continue";
	/** Text generated in this step */
	text: string;
	/** Tool calls made in this step */
	toolCalls: ToolCall[];
	/** Tool results from this step */
	toolResults: ToolResult[];
	/** Reason the step finished */
	finishReason: FinishReason;
	/** Token usage for this step */
	usage: TokenUsage;
	/** Whether this is the final step */
	isFinalStep: boolean;
}

/**
 * Reasons why generation finished
 */
export type FinishReason =
	| "stop"
	| "length"
	| "content-filter"
	| "tool-calls"
	| "error"
	| "other";

/**
 * Token usage information
 */
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/**
 * Chunk types for streaming
 */
export type StreamChunkType =
	| "text-delta"
	| "tool-call"
	| "tool-call-streaming-start"
	| "tool-call-delta"
	| "tool-result"
	| "step-finish"
	| "finish"
	| "error";

/**
 * A chunk emitted during streaming
 */
export interface StreamChunk {
	type: StreamChunkType;
	/** Text delta for text-delta chunks */
	textDelta?: string;
	/** Tool call information */
	toolCall?: ToolCall;
	/** Partial tool call arguments for streaming */
	toolCallDelta?: {
		toolCallId: string;
		argsTextDelta: string;
	};
	/** Tool result for tool-result chunks */
	toolResult?: ToolResult;
	/** Step result for step-finish chunks */
	stepResult?: StepResult;
	/** Error for error chunks */
	error?: Error;
}

/**
 * Callback for when a step finishes
 */
export type OnStepFinishCallback = (result: StepResult) => Promise<void> | void;

/**
 * Callback for when a chunk is received during streaming
 */
export type OnChunkCallback = (chunk: StreamChunk) => Promise<void> | void;

/**
 * Callback for when the entire generation finishes
 */
export type OnFinishCallback = (result: AgentResponse) => Promise<void> | void;

/**
 * Callback for tool execution approval (human-in-the-loop)
 */
export type OnToolApprovalCallback = (
	toolCall: ToolCall
) => Promise<boolean> | boolean;

/**
 * Callback for before each step starts
 */
export type OnStepStartCallback = (stepNumber: number) => Promise<void> | void;

/**
 * Callback for token usage updates
 */
export type OnUsageCallback = (usage: TokenUsage) => Promise<void> | void;

/**
 * Callback for errors during execution
 */
export type OnErrorCallback = (error: Error, context: ErrorContext) => Promise<void> | void;

/**
 * Context information when an error occurs
 */
export interface ErrorContext {
	stepNumber: number;
	phase: "generation" | "tool-execution" | "parsing";
	toolName?: string;
	toolCallId?: string;
}

/**
 * Configuration for agent execution
 */
export interface AgentExecutionConfig {
	/** Maximum number of steps before stopping (default: 10) */
	maxSteps?: number;
	/** Maximum tokens for the response */
	maxTokens?: number;
	/** Temperature for generation (0-2) */
	temperature?: number;
	/** Top P for nucleus sampling */
	topP?: number;
	/** Custom stop sequences */
	stopSequences?: string[];
	/** Whether to enable streaming */
	stream?: boolean;
	/** Abort signal for cancellation */
	abortSignal?: AbortSignal;
}

/**
 * Callbacks for agent execution
 */
export interface AgentCallbacks {
	/** Called when a step finishes */
	onStepFinish?: OnStepFinishCallback;
	/** Called for each chunk during streaming */
	onChunk?: OnChunkCallback;
	/** Called when generation is complete */
	onFinish?: OnFinishCallback;
	/** Called before each step starts */
	onStepStart?: OnStepStartCallback;
	/** Called for token usage updates */
	onUsage?: OnUsageCallback;
	/** Called when an error occurs */
	onError?: OnErrorCallback;
	/** Called to approve tool execution (human-in-the-loop) */
	onToolApproval?: OnToolApprovalCallback;
}

/**
 * Full agent response after execution
 */
export interface AgentResponse {
	/** Final generated text */
	text: string;
	/** All messages in the conversation including new ones */
	messages: ConversationMessage[];
	/** All steps executed */
	steps: StepResult[];
	/** Reason generation finished */
	finishReason: FinishReason;
	/** Total token usage across all steps */
	usage: TokenUsage;
	/** Whether the agent completed successfully */
	isComplete: boolean;
	/** Error if the agent failed */
	error?: Error;
}

/**
 * Streaming response that can be consumed incrementally
 */
export interface AgentStreamResponse {
	/** Async iterator for chunks */
	[Symbol.asyncIterator](): AsyncIterableIterator<StreamChunk>;
	/** Get the full text once streaming completes */
	readonly text: Promise<string>;
	/** Get all steps once streaming completes */
	readonly steps: Promise<StepResult[]>;
	/** Get token usage once streaming completes */
	readonly usage: Promise<TokenUsage>;
	/** Get the full response once streaming completes */
	readonly response: Promise<AgentResponse>;
}

/**
 * Condition for stopping the agent loop
 */
export type StopCondition =
	| { type: "maxSteps"; value: number }
	| { type: "toolResult"; toolName: string }
	| { type: "custom"; predicate: (step: StepResult) => boolean };

/**
 * Configuration for the agent
 */
export interface AgentConfig {
	/** Model configuration */
	model: ModelConfig;
	/** System prompt for the agent */
	systemPrompt?: string;
	/**
	 * Tools available to the agent.
	 * In v5, pass tools created with tool() helper from 'ai' package.
	 * Example: { weatherTool, calculatorTool }
	 */
	tools?: Record<string, any>;
	/** Default execution configuration */
	defaultExecutionConfig?: AgentExecutionConfig;
	/** Default callbacks */
	defaultCallbacks?: AgentCallbacks;
	/** Stop conditions for the agentic loop */
	stopWhen?: StopCondition[];
}

/**
 * Input for running the agent
 */
export interface AgentRunInput {
	/** User message or messages */
	messages: UIMessage[] | string;
	/** Override execution config for this run */
	executionConfig?: AgentExecutionConfig;
	/** Override callbacks for this run */
	callbacks?: AgentCallbacks;
}

/**
 * Creates a unique message ID
 */
export function createMessageId(): string {
	return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
