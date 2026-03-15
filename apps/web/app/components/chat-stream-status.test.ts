import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	getStreamActivityLabel,
	hasAssistantText,
	isStatusReasoningText,
} from "./chat-stream-status";

function assistantMessage(parts: UIMessage["parts"]): UIMessage {
	return {
		id: "assistant-1",
		role: "assistant",
		parts,
	} as UIMessage;
}

describe("chat stream status helpers", () => {
	it("detects status reasoning labels that should stay out of the transcript body", () => {
		expect(isStatusReasoningText("Preparing response...")).toBe(true);
		expect(
			isStatusReasoningText(
				"Optimizing session context...\nRetrying with compacted context...",
			),
		).toBe(true);
		expect(isStatusReasoningText("Planning the requested changes")).toBe(false);
	});

	it("keeps the stream activity row visible after assistant text has started", () => {
		const label = getStreamActivityLabel({
			loadingSession: false,
			isReconnecting: false,
			status: "streaming",
			hasRunningSubagents: false,
			lastMessage: assistantMessage([
				{ type: "text", text: "Drafting the final answer now..." },
			] as UIMessage["parts"]),
		});

		expect(label).toBe("Still streaming...");
		expect(
			hasAssistantText(
				assistantMessage([
					{ type: "text", text: "Drafting the final answer now..." },
				] as UIMessage["parts"]),
			),
		).toBe(true);
	});

	it("prefers gateway status reasoning over the generic streaming label", () => {
		const label = getStreamActivityLabel({
			loadingSession: false,
			isReconnecting: false,
			status: "streaming",
			hasRunningSubagents: false,
			lastMessage: assistantMessage([
				{
					type: "reasoning",
					text: "Optimizing session context...\nRetrying with compacted context...",
				},
			] as UIMessage["parts"]),
		});

		expect(label).toBe("Optimizing session context... Retrying with compacted context...");
	});

	it("surfaces the active tool name while a tool call is still running", () => {
		const label = getStreamActivityLabel({
			loadingSession: false,
			isReconnecting: false,
			status: "streaming",
			hasRunningSubagents: false,
			lastMessage: assistantMessage([
				{
					type: "dynamic-tool",
					toolName: "read_file",
					toolCallId: "tool-1",
					state: "input-available",
					input: {},
				},
			] as UIMessage["parts"]),
		});

		expect(label).toBe("Running Read File...");
	});

	it("shows waiting for subagents as the top-priority active status", () => {
		const label = getStreamActivityLabel({
			loadingSession: false,
			isReconnecting: false,
			status: "streaming",
			hasRunningSubagents: true,
			lastMessage: assistantMessage([
				{ type: "text", text: "Initial draft is ready." },
			] as UIMessage["parts"]),
		});

		expect(label).toBe("Waiting for subagents...");
	});
});
