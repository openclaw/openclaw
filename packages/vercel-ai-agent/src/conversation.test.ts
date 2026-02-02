import { describe, it, expect, beforeEach } from "vitest";
import {
	ConversationManager,
	createConversationManager,
	formatMessageForDisplay,
	estimateTokenCount,
	truncateToTokenBudget,
} from "./conversation.js";
import type { ConversationMessage } from "./types.js";

describe("ConversationManager", () => {
	let manager: ConversationManager;

	beforeEach(() => {
		manager = createConversationManager();
	});

	describe("session management", () => {
		it("should create a new session", () => {
			const sessionId = manager.createSession();
			expect(sessionId).toBeDefined();
			expect(manager.getSession(sessionId)).toBeDefined();
		});

		it("should create session with title and metadata", () => {
			const sessionId = manager.createSession({
				title: "Test Session",
				metadata: { key: "value" },
			});

			const session = manager.getSession(sessionId);
			expect(session?.metadata.title).toBe("Test Session");
			expect(session?.metadata.metadata).toEqual({ key: "value" });
		});

		it("should track session count", () => {
			expect(manager.sessionCount).toBe(0);
			manager.createSession();
			expect(manager.sessionCount).toBe(1);
			manager.createSession();
			expect(manager.sessionCount).toBe(2);
		});

		it("should get or create active session", () => {
			const sessionId = manager.getOrCreateActiveSession();
			expect(sessionId).toBeDefined();

			const sameSessionId = manager.getOrCreateActiveSession();
			expect(sameSessionId).toBe(sessionId);
		});

		it("should set active session", () => {
			const session1 = manager.createSession();
			const session2 = manager.createSession();

			manager.setActiveSession(session2);
			expect(manager.getOrCreateActiveSession()).toBe(session2);
		});

		it("should throw when setting nonexistent active session", () => {
			expect(() => manager.setActiveSession("nonexistent")).toThrow(
				"Session nonexistent not found"
			);
		});

		it("should delete session", () => {
			const sessionId = manager.createSession();
			expect(manager.deleteSession(sessionId)).toBe(true);
			expect(manager.getSession(sessionId)).toBeUndefined();
		});

		it("should clear active session when deleted", () => {
			const sessionId = manager.getOrCreateActiveSession();
			manager.deleteSession(sessionId);
			expect(manager.getActiveSession()).toBeUndefined();
		});

		it("should get all session IDs", () => {
			const id1 = manager.createSession();
			const id2 = manager.createSession();

			const ids = manager.getSessionIds();
			expect(ids).toContain(id1);
			expect(ids).toContain(id2);
		});
	});

	describe("message management", () => {
		let sessionId: string;

		beforeEach(() => {
			sessionId = manager.createSession();
		});

		it("should add user message", () => {
			const message = manager.addUserMessage(sessionId, "Hello");
			expect(message.role).toBe("user");
			expect(message.content).toBe("Hello");
			expect(message.id).toBeDefined();
			expect(message.createdAt).toBeInstanceOf(Date);
		});

		it("should add assistant message", () => {
			const message = manager.addAssistantMessage(sessionId, "Hi there!");
			expect(message.role).toBe("assistant");
			expect(message.content).toBe("Hi there!");
		});

		it("should add assistant message with tool calls", () => {
			const toolCalls = [
				{ id: "tc1", name: "test_tool", arguments: { input: "test" } },
			];
			const message = manager.addAssistantMessage(
				sessionId,
				"Using tool...",
				toolCalls
			);
			expect(message.toolCalls).toEqual(toolCalls);
		});

		it("should add system message", () => {
			const message = manager.addSystemMessage(
				sessionId,
				"You are a helpful assistant"
			);
			expect(message.role).toBe("system");
		});

		it("should add tool result message", () => {
			const toolResult = {
				toolCallId: "tc1",
				toolName: "test_tool",
				result: { output: "success" },
				isSuccess: true,
			};
			const message = manager.addToolResultMessage(sessionId, toolResult);
			expect(message.role).toBe("tool");
			expect(message.toolResult).toEqual(toolResult);
		});

		it("should throw when adding message to nonexistent session", () => {
			expect(() => manager.addUserMessage("nonexistent", "Hello")).toThrow(
				"Session nonexistent not found"
			);
		});

		it("should get messages from session", () => {
			manager.addUserMessage(sessionId, "Hello");
			manager.addAssistantMessage(sessionId, "Hi!");

			const messages = manager.getMessages(sessionId);
			expect(messages.length).toBe(2);
		});

		it("should filter messages by role", () => {
			manager.addUserMessage(sessionId, "Hello");
			manager.addAssistantMessage(sessionId, "Hi!");
			manager.addUserMessage(sessionId, "How are you?");

			const userMessages = manager.getMessages(sessionId, { roles: ["user"] });
			expect(userMessages.length).toBe(2);
			expect(userMessages.every((m) => m.role === "user")).toBe(true);
		});

		it("should apply limit and offset", () => {
			manager.addUserMessage(sessionId, "1");
			manager.addUserMessage(sessionId, "2");
			manager.addUserMessage(sessionId, "3");
			manager.addUserMessage(sessionId, "4");

			const messages = manager.getMessages(sessionId, { offset: 1, limit: 2 });
			expect(messages.length).toBe(2);
			expect(messages[0].content).toBe("2");
			expect(messages[1].content).toBe("3");
		});

		it("should get last N messages", () => {
			manager.addUserMessage(sessionId, "1");
			manager.addUserMessage(sessionId, "2");
			manager.addUserMessage(sessionId, "3");

			const messages = manager.getLastMessages(sessionId, 2);
			expect(messages.length).toBe(2);
			expect(messages[0].content).toBe("2");
			expect(messages[1].content).toBe("3");
		});

		it("should clear messages", () => {
			manager.addUserMessage(sessionId, "Hello");
			manager.clearMessages(sessionId);

			const messages = manager.getMessages(sessionId);
			expect(messages.length).toBe(0);
		});

		it("should update session updatedAt when adding message", () => {
			const session = manager.getSession(sessionId)!;
			const initialUpdatedAt = session.metadata.updatedAt;

			// Wait a bit to ensure time difference
			manager.addUserMessage(sessionId, "Hello");

			const updatedSession = manager.getSession(sessionId)!;
			expect(updatedSession.metadata.updatedAt.getTime()).toBeGreaterThanOrEqual(
				initialUpdatedAt.getTime()
			);
		});
	});

	describe("max messages limit", () => {
		it("should trim messages when exceeding max", () => {
			const limitedManager = createConversationManager({ maxMessages: 3 });
			const sessionId = limitedManager.createSession();

			limitedManager.addUserMessage(sessionId, "1");
			limitedManager.addUserMessage(sessionId, "2");
			limitedManager.addUserMessage(sessionId, "3");
			limitedManager.addUserMessage(sessionId, "4");

			const messages = limitedManager.getMessages(sessionId);
			expect(messages.length).toBe(3);
			expect(messages[0].content).toBe("2");
		});
	});

	describe("token usage tracking", () => {
		it("should update and get usage", () => {
			const sessionId = manager.createSession();

			manager.updateUsage(sessionId, {
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
			});

			const usage = manager.getUsage(sessionId);
			expect(usage).toEqual({
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
			});
		});

		it("should accumulate usage", () => {
			const sessionId = manager.createSession();

			manager.updateUsage(sessionId, {
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
			});

			manager.updateUsage(sessionId, {
				promptTokens: 50,
				completionTokens: 25,
				totalTokens: 75,
			});

			const usage = manager.getUsage(sessionId);
			expect(usage).toEqual({
				promptTokens: 150,
				completionTokens: 75,
				totalTokens: 225,
			});
		});
	});

	describe("session metadata", () => {
		it("should update session metadata", () => {
			const sessionId = manager.createSession();

			manager.updateSessionMetadata(sessionId, {
				title: "New Title",
				metadata: { custom: "data" },
			});

			const session = manager.getSession(sessionId);
			expect(session?.metadata.title).toBe("New Title");
			expect(session?.metadata.metadata).toEqual({ custom: "data" });
		});
	});

	describe("export/import", () => {
		it("should export session to JSON", () => {
			const sessionId = manager.createSession({ title: "Test" });
			manager.addUserMessage(sessionId, "Hello");

			const json = manager.exportSession(sessionId);
			expect(json).toBeDefined();

			const parsed = JSON.parse(json!);
			expect(parsed.metadata.title).toBe("Test");
			expect(parsed.messages.length).toBe(1);
		});

		it("should return null for nonexistent session", () => {
			expect(manager.exportSession("nonexistent")).toBeNull();
		});

		it("should import session from JSON", () => {
			const sessionId = manager.createSession({ title: "Original" });
			manager.addUserMessage(sessionId, "Hello");
			const json = manager.exportSession(sessionId)!;

			const newId = manager.importSession(json);
			expect(newId).not.toBe(sessionId);

			const imported = manager.getSession(newId);
			expect(imported?.messages.length).toBe(1);
		});
	});

	describe("clearAll", () => {
		it("should clear all sessions", () => {
			manager.createSession();
			manager.createSession();

			manager.clearAll();

			expect(manager.sessionCount).toBe(0);
			expect(manager.getActiveSession()).toBeUndefined();
		});
	});
});

describe("formatMessageForDisplay", () => {
	it("should format user message", () => {
		const message: ConversationMessage = {
			id: "test",
			role: "user",
			content: "Hello",
			createdAt: new Date(),
		};

		const formatted = formatMessageForDisplay(message);
		expect(formatted).toBe("[User] Hello");
	});

	it("should format assistant message", () => {
		const message: ConversationMessage = {
			id: "test",
			role: "assistant",
			content: "Hi there!",
			createdAt: new Date(),
		};

		const formatted = formatMessageForDisplay(message);
		expect(formatted).toBe("[Assistant] Hi there!");
	});

	it("should truncate long content", () => {
		const longContent = "a".repeat(600);
		const message: ConversationMessage = {
			id: "test",
			role: "user",
			content: longContent,
			createdAt: new Date(),
		};

		const formatted = formatMessageForDisplay(message);
		expect(formatted.length).toBeLessThan(longContent.length + 20);
		expect(formatted).toContain("...");
	});

	it("should include tool call info", () => {
		const message: ConversationMessage = {
			id: "test",
			role: "assistant",
			content: "Using tool",
			toolCalls: [
				{ id: "tc1", name: "calculator", arguments: {} },
				{ id: "tc2", name: "search", arguments: {} },
			],
			createdAt: new Date(),
		};

		const formatted = formatMessageForDisplay(message);
		expect(formatted).toContain("calculator");
		expect(formatted).toContain("search");
	});
});

describe("estimateTokenCount", () => {
	it("should estimate tokens for short message", () => {
		const message: ConversationMessage = {
			id: "test",
			role: "user",
			content: "Hello world",
			createdAt: new Date(),
		};

		const tokens = estimateTokenCount(message);
		expect(tokens).toBeGreaterThan(0);
	});

	it("should include tool call overhead", () => {
		const messageWithoutTools: ConversationMessage = {
			id: "test",
			role: "assistant",
			content: "Hello",
			createdAt: new Date(),
		};

		const messageWithTools: ConversationMessage = {
			id: "test",
			role: "assistant",
			content: "Hello",
			toolCalls: [{ id: "tc1", name: "test", arguments: { key: "value" } }],
			createdAt: new Date(),
		};

		expect(estimateTokenCount(messageWithTools)).toBeGreaterThan(
			estimateTokenCount(messageWithoutTools)
		);
	});
});

describe("truncateToTokenBudget", () => {
	const createMessage = (
		content: string,
		role: ConversationMessage["role"] = "user"
	): ConversationMessage => ({
		id: `msg_${content}`,
		role,
		content,
		createdAt: new Date(),
	});

	it("should preserve system messages", () => {
		const messages = [
			createMessage("System prompt", "system"),
			createMessage("User 1"),
			createMessage("User 2"),
			createMessage("User 3"),
		];

		const truncated = truncateToTokenBudget(messages, 50, {
			preserveSystemMessages: true,
		});

		expect(truncated.some((m) => m.role === "system")).toBe(true);
	});

	it("should preserve last N messages", () => {
		const messages = [
			createMessage("User 1"),
			createMessage("User 2"),
			createMessage("User 3"),
			createMessage("User 4"),
		];

		const truncated = truncateToTokenBudget(messages, 30, {
			preserveLastN: 2,
		});

		// Last 2 should always be preserved
		expect(truncated[truncated.length - 1].content).toBe("User 4");
		expect(truncated[truncated.length - 2].content).toBe("User 3");
	});

	it("should respect token budget", () => {
		const messages = Array.from({ length: 10 }, (_, i) =>
			createMessage("x".repeat(100))
		);

		const truncated = truncateToTokenBudget(messages, 100);

		// Should have fewer messages due to token limit
		expect(truncated.length).toBeLessThan(messages.length);
	});
});
