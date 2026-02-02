// Core agent
export { ConversationalAgent, createAgent } from "./agent.js";

// Types
export type {
	// Model configuration
	ModelProvider,
	ModelConfig,
	// Tool types
	ToolParameters,
	AgentToolDefinition,
	// Message types
	MessageRole,
	ConversationMessage,
	ToolCall,
	ToolResult,
	// Step and response types
	StepResult,
	FinishReason,
	TokenUsage,
	AgentResponse,
	// Streaming types
	StreamChunkType,
	StreamChunk,
	AgentStreamResponse,
	// Callback types
	OnStepFinishCallback,
	OnChunkCallback,
	OnFinishCallback,
	OnToolApprovalCallback,
	OnStepStartCallback,
	OnUsageCallback,
	OnErrorCallback,
	ErrorContext,
	// Configuration types
	AgentExecutionConfig,
	AgentCallbacks,
	StopCondition,
	AgentConfig,
	AgentRunInput,
} from "./types.js";

export { createMessageId } from "./types.js";

// Tool registry and built-in tools
export {
	ToolRegistry,
	createToolRegistry,
	defaultRegistry,
	calculatorTool,
	dateTimeTool,
	jsonTool,
	stringTool,
	waitTool,
	createMemoryTool,
	builtinTools,
	createBuiltinTools,
} from "./tools/index.js";

// Conversation management
export {
	ConversationManager,
	createConversationManager,
	formatMessageForDisplay,
	estimateTokenCount,
	truncateToTokenBudget,
} from "./conversation.js";

export type {
	ConversationConfig,
	SessionMetadata,
	ConversationSession,
} from "./conversation.js";

// Streaming utilities
export {
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

export type {
	StreamProcessorOptions,
	StreamState,
	StreamEvent,
	StreamEventHandler,
} from "./streaming.js";

// Re-export useful types from AI SDK v5 for convenience
export type { UIMessage } from "ai";
