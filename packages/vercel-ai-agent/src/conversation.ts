import type {
	ConversationMessage,
	MessageRole,
	ToolCall,
	ToolResult,
	TokenUsage,
} from "./types.js";
import { createMessageId } from "./types.js";

/**
 * Configuration for conversation management
 */
export interface ConversationConfig {
	/** Maximum number of messages to keep in history */
	maxMessages?: number;
	/** Maximum total tokens to keep in context */
	maxContextTokens?: number;
	/** Whether to include system messages in history */
	includeSystemMessages?: boolean;
	/** Custom message ID generator */
	generateId?: () => string;
}

/**
 * Session metadata
 */
export interface SessionMetadata {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	title?: string;
	/** Custom metadata */
	metadata?: Record<string, unknown>;
}

/**
 * A conversation session containing messages and metadata
 */
export interface ConversationSession {
	metadata: SessionMetadata;
	messages: ConversationMessage[];
	/** Total tokens used in this session */
	totalUsage: TokenUsage;
}

/**
 * Manages conversation history and sessions
 */
export class ConversationManager {
	private sessions: Map<string, ConversationSession> = new Map();
	private activeSessionId: string | null = null;
	private config: ConversationConfig;

	constructor(config: ConversationConfig = {}) {
		this.config = {
			maxMessages: config.maxMessages ?? 100,
			maxContextTokens: config.maxContextTokens,
			includeSystemMessages: config.includeSystemMessages ?? true,
			generateId: config.generateId ?? createMessageId,
		};
	}

	/**
	 * Create a new conversation session
	 */
	createSession(options?: { title?: string; metadata?: Record<string, unknown> }): string {
		const sessionId = this.config.generateId!();
		const now = new Date();

		const session: ConversationSession = {
			metadata: {
				id: sessionId,
				createdAt: now,
				updatedAt: now,
				title: options?.title,
				metadata: options?.metadata,
			},
			messages: [],
			totalUsage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			},
		};

		this.sessions.set(sessionId, session);
		return sessionId;
	}

	/**
	 * Get or create the active session
	 */
	getOrCreateActiveSession(): string {
		if (!this.activeSessionId || !this.sessions.has(this.activeSessionId)) {
			this.activeSessionId = this.createSession();
		}
		return this.activeSessionId;
	}

	/**
	 * Set the active session
	 */
	setActiveSession(sessionId: string): void {
		if (!this.sessions.has(sessionId)) {
			throw new Error(`Session ${sessionId} not found`);
		}
		this.activeSessionId = sessionId;
	}

	/**
	 * Get a session by ID
	 */
	getSession(sessionId: string): ConversationSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get the active session
	 */
	getActiveSession(): ConversationSession | undefined {
		if (!this.activeSessionId) {
			return undefined;
		}
		return this.sessions.get(this.activeSessionId);
	}

	/**
	 * Get all session IDs
	 */
	getSessionIds(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Delete a session
	 */
	deleteSession(sessionId: string): boolean {
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null;
		}
		return this.sessions.delete(sessionId);
	}

	/**
	 * Add a message to a session
	 */
	addMessage(
		sessionId: string,
		message: Omit<ConversationMessage, "id" | "createdAt">
	): ConversationMessage {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const fullMessage: ConversationMessage = {
			...message,
			id: this.config.generateId!(),
			createdAt: new Date(),
		};

		session.messages.push(fullMessage);
		session.metadata.updatedAt = new Date();

		// Trim if over max messages
		if (
			this.config.maxMessages &&
			session.messages.length > this.config.maxMessages
		) {
			const excess = session.messages.length - this.config.maxMessages;
			session.messages.splice(0, excess);
		}

		return fullMessage;
	}

	/**
	 * Add a user message
	 */
	addUserMessage(sessionId: string, content: string): ConversationMessage {
		return this.addMessage(sessionId, {
			role: "user",
			content,
		});
	}

	/**
	 * Add an assistant message
	 */
	addAssistantMessage(
		sessionId: string,
		content: string,
		toolCalls?: ToolCall[]
	): ConversationMessage {
		return this.addMessage(sessionId, {
			role: "assistant",
			content,
			toolCalls,
		});
	}

	/**
	 * Add a tool result message
	 */
	addToolResultMessage(
		sessionId: string,
		toolResult: ToolResult
	): ConversationMessage {
		return this.addMessage(sessionId, {
			role: "tool",
			content: JSON.stringify(toolResult.result),
			toolResult,
		});
	}

	/**
	 * Add a system message
	 */
	addSystemMessage(sessionId: string, content: string): ConversationMessage {
		return this.addMessage(sessionId, {
			role: "system",
			content,
		});
	}

	/**
	 * Get messages from a session
	 */
	getMessages(
		sessionId: string,
		options?: {
			limit?: number;
			offset?: number;
			roles?: MessageRole[];
		}
	): ConversationMessage[] {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return [];
		}

		let messages = [...session.messages];

		// Filter by role if specified
		if (options?.roles && options.roles.length > 0) {
			messages = messages.filter((m) => options.roles!.includes(m.role));
		}

		// Apply offset and limit
		if (options?.offset) {
			messages = messages.slice(options.offset);
		}
		if (options?.limit) {
			messages = messages.slice(0, options.limit);
		}

		return messages;
	}

	/**
	 * Get the last N messages from a session
	 */
	getLastMessages(sessionId: string, count: number): ConversationMessage[] {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return session.messages.slice(-count);
	}

	/**
	 * Update token usage for a session
	 */
	updateUsage(sessionId: string, usage: TokenUsage): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		session.totalUsage.promptTokens += usage.promptTokens;
		session.totalUsage.completionTokens += usage.completionTokens;
		session.totalUsage.totalTokens += usage.totalTokens;
		session.metadata.updatedAt = new Date();
	}

	/**
	 * Get total usage for a session
	 */
	getUsage(sessionId: string): TokenUsage | undefined {
		return this.sessions.get(sessionId)?.totalUsage;
	}

	/**
	 * Clear all messages in a session
	 */
	clearMessages(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.messages = [];
			session.metadata.updatedAt = new Date();
		}
	}

	/**
	 * Update session metadata
	 */
	updateSessionMetadata(
		sessionId: string,
		updates: Partial<Omit<SessionMetadata, "id" | "createdAt" | "updatedAt">>
	): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session ${sessionId} not found`);
		}

		Object.assign(session.metadata, updates);
		session.metadata.updatedAt = new Date();
	}

	/**
	 * Export a session to JSON
	 */
	exportSession(sessionId: string): string | null {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return null;
		}
		return JSON.stringify(session, null, 2);
	}

	/**
	 * Import a session from JSON
	 */
	importSession(json: string): string {
		const session = JSON.parse(json) as ConversationSession;

		// Regenerate ID to avoid conflicts
		const newId = this.config.generateId!();
		session.metadata.id = newId;

		// Convert date strings back to Date objects
		session.metadata.createdAt = new Date(session.metadata.createdAt);
		session.metadata.updatedAt = new Date(session.metadata.updatedAt);
		for (const msg of session.messages) {
			msg.createdAt = new Date(msg.createdAt);
		}

		this.sessions.set(newId, session);
		return newId;
	}

	/**
	 * Get session count
	 */
	get sessionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Clear all sessions
	 */
	clearAll(): void {
		this.sessions.clear();
		this.activeSessionId = null;
	}
}

/**
 * Utility to format messages for display
 */
export function formatMessageForDisplay(message: ConversationMessage): string {
	const roleLabels: Record<MessageRole, string> = {
		user: "User",
		assistant: "Assistant",
		system: "System",
		tool: "Tool",
	};

	const roleLabel = roleLabels[message.role] || message.role;
	let content = message.content;

	// Truncate long content
	if (content.length > 500) {
		content = content.substring(0, 500) + "...";
	}

	// Add tool call info if present
	if (message.toolCalls && message.toolCalls.length > 0) {
		const toolNames = message.toolCalls.map((tc) => tc.name).join(", ");
		content += `\n[Called tools: ${toolNames}]`;
	}

	return `[${roleLabel}] ${content}`;
}

/**
 * Utility to estimate token count for a message
 * This is a rough approximation - actual token counts vary by model
 */
export function estimateTokenCount(message: ConversationMessage): number {
	// Rough estimate: ~4 characters per token for English text
	const contentTokens = Math.ceil(message.content.length / 4);

	// Add some overhead for message structure
	const overhead = 4; // Role, separators, etc.

	// Add tokens for tool calls if present
	let toolTokens = 0;
	if (message.toolCalls) {
		for (const tc of message.toolCalls) {
			toolTokens += Math.ceil(JSON.stringify(tc.arguments).length / 4) + 10;
		}
	}

	return contentTokens + overhead + toolTokens;
}

/**
 * Utility to truncate conversation history to fit token budget
 */
export function truncateToTokenBudget(
	messages: ConversationMessage[],
	maxTokens: number,
	options?: {
		preserveSystemMessages?: boolean;
		preserveLastN?: number;
	}
): ConversationMessage[] {
	const preserveSystemMessages = options?.preserveSystemMessages ?? true;
	const preserveLastN = options?.preserveLastN ?? 2;

	// Separate system messages and regular messages
	const systemMessages = preserveSystemMessages
		? messages.filter((m) => m.role === "system")
		: [];
	const otherMessages = preserveSystemMessages
		? messages.filter((m) => m.role !== "system")
		: [...messages];

	// Calculate tokens for system messages
	let usedTokens = systemMessages.reduce(
		(sum, m) => sum + estimateTokenCount(m),
		0
	);

	// Always preserve the last N messages
	const preservedMessages = otherMessages.slice(-preserveLastN);
	const remainingMessages = otherMessages.slice(0, -preserveLastN);

	// Calculate tokens for preserved messages
	usedTokens += preservedMessages.reduce(
		(sum, m) => sum + estimateTokenCount(m),
		0
	);

	// Add messages from the end until we hit the budget
	const selectedMessages: ConversationMessage[] = [];

	for (let i = remainingMessages.length - 1; i >= 0; i--) {
		const msg = remainingMessages[i];
		const tokens = estimateTokenCount(msg);

		if (usedTokens + tokens <= maxTokens) {
			selectedMessages.unshift(msg);
			usedTokens += tokens;
		} else {
			break;
		}
	}

	return [...systemMessages, ...selectedMessages, ...preservedMessages];
}

/**
 * Create a new conversation manager
 */
export function createConversationManager(
	config?: ConversationConfig
): ConversationManager {
	return new ConversationManager(config);
}
