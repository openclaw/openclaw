import type { UIMessage } from "ai";

export const STREAM_STATUS_REASONING_LABELS = [
	"Preparing response...",
	"Optimizing session context...",
	"Waiting for subagent results...",
	"Waiting for subagents...",
] as const;

type ChatStatus = "submitted" | "streaming" | "ready" | "error";
type MessagePart = UIMessage["parts"][number];

function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function humanizeToolName(toolName: string): string {
	const normalized = toolName
		.replace(/^tool-/, "")
		.replace(/[_-]+/g, " ")
		.trim();

	if (!normalized) {
		return "tool";
	}

	return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function hasNonEmptyTextPart(part: MessagePart): boolean {
	return (
		part.type === "text" &&
		typeof (part as { text?: unknown }).text === "string" &&
		collapseWhitespace((part as { text: string }).text).length > 0
	);
}

function isToolLikePart(part: MessagePart): boolean {
	return (
		part.type === "dynamic-tool" ||
		part.type === "tool-invocation" ||
		part.type.startsWith("tool-")
	);
}

function getLastToolLikePart(parts: UIMessage["parts"]): MessagePart | null {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (isToolLikePart(part)) {
			return part;
		}
	}
	return null;
}

function getLastToolLikePartIndex(parts: UIMessage["parts"]): number {
	for (let i = parts.length - 1; i >= 0; i--) {
		if (isToolLikePart(parts[i])) {
			return i;
		}
	}
	return -1;
}

function didToolPartEndInError(part: MessagePart | null): boolean {
	if (!part) {
		return false;
	}
	const state = resolveToolState(part);
	if (state === "error") {
		return true;
	}
	if (part.type === "tool-invocation") {
		const result = (part as { result?: unknown }).result;
		if (result && typeof result === "object") {
			const record = result as Record<string, unknown>;
			const status = typeof record.status === "string" ? record.status.toLowerCase() : null;
			if (status === "error" || status === "failed") {
				return true;
			}
		}
	}
	return false;
}

function resolveToolName(part: MessagePart): string | null {
	if (part.type === "dynamic-tool") {
		return typeof part.toolName === "string" ? part.toolName : null;
	}

	if (!part.type.startsWith("tool-")) {
		return null;
	}

	const toolPart = part as {
		type: string;
		title?: unknown;
		toolName?: unknown;
	};

	if (typeof toolPart.title === "string" && toolPart.title.trim()) {
		return toolPart.title;
	}
	if (typeof toolPart.toolName === "string" && toolPart.toolName.trim()) {
		return toolPart.toolName;
	}

	return part.type.replace(/^tool-/, "");
}

function resolveToolState(part: MessagePart): string | null {
	if (part.type === "dynamic-tool") {
		return typeof part.state === "string"
			? part.state
			: "input-available";
	}

	if (!part.type.startsWith("tool-")) {
		return null;
	}

	const toolPart = part as {
		state?: unknown;
		errorText?: unknown;
		output?: unknown;
		result?: unknown;
	};

	if (typeof toolPart.state === "string") {
		return toolPart.state;
	}
	if (typeof toolPart.errorText === "string" && toolPart.errorText.trim()) {
		return "error";
	}
	if ("result" in toolPart || "output" in toolPart) {
		return "output-available";
	}

	return "input-available";
}

export function hasAssistantText(message: UIMessage | null): boolean {
	return Boolean(
		message?.role === "assistant" &&
		message.parts.some((part) => hasNonEmptyTextPart(part)),
	);
}

export function hasAssistantToolActivity(message: UIMessage | null): boolean {
	return Boolean(
		message?.role === "assistant" &&
		message.parts.some(
			(part) =>
				part.type === "reasoning" ||
				part.type === "dynamic-tool" ||
				part.type.startsWith("tool-") ||
				part.type === "tool-invocation",
		),
	);
}

export function hasAssistantPostToolText(message: UIMessage | null): boolean {
	if (!message || message.role !== "assistant") {
		return false;
	}
	const lastToolIndex = getLastToolLikePartIndex(message.parts);
	if (lastToolIndex === -1) {
		return hasAssistantText(message);
	}
	return message.parts.slice(lastToolIndex + 1).some((part) => hasNonEmptyTextPart(part));
}

export function getIncompleteAssistantReplyReason(message: UIMessage | null): string | null {
	if (!message || message.role !== "assistant") {
		return null;
	}
	const lastToolIndex = getLastToolLikePartIndex(message.parts);
	if (lastToolIndex === -1 || hasAssistantPostToolText(message)) {
		return null;
	}
	const lastTool = getLastToolLikePart(message.parts);
	if (didToolPartEndInError(lastTool)) {
		return "Tool execution failed and the agent stopped without summarizing the failure.";
	}
	const toolNames = message.parts
		.filter((part) => isToolLikePart(part))
		.map((part) => resolveToolName(part))
		.filter((toolName): toolName is string => Boolean(toolName));
	if (
		toolNames.includes("composio_search_tools") &&
		!toolNames.includes("composio_call_tool")
	) {
		return "Search completed but the agent never followed through with the tool call.";
	}
	return "Agent finished tool activity but did not send a final text reply.";
}

export function isStatusReasoningText(text: string): boolean {
	return STREAM_STATUS_REASONING_LABELS.some((label) =>
		text.startsWith(label),
	);
}

function getLatestStatusReasoning(parts: UIMessage["parts"]): string | null {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (part.type !== "reasoning") {
			continue;
		}

		const text =
			typeof (part as { text?: unknown }).text === "string"
				? collapseWhitespace((part as { text: string }).text)
				: "";

		if (text && isStatusReasoningText(text)) {
			return text;
		}
	}

	return null;
}

function getRunningToolLabel(parts: UIMessage["parts"]): string | null {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		const state = resolveToolState(part);
		if (!state || state === "output-available" || state === "error") {
			continue;
		}

		const toolName = resolveToolName(part);
		if (!toolName) {
			continue;
		}

		if (toolName === "sessions_spawn") {
			return "Starting subagent...";
		}

		return `Running ${humanizeToolName(toolName)}...`;
	}

	return null;
}

export function getStreamActivityLabel({
	loadingSession,
	isReconnecting,
	status,
	hasRunningSubagents,
	lastMessage,
}: {
	loadingSession: boolean;
	isReconnecting: boolean;
	status: ChatStatus;
	hasRunningSubagents: boolean;
	lastMessage: UIMessage | null;
}): string | null {
	if (loadingSession) {
		return "Loading session...";
	}

	if (isReconnecting) {
		return "Resuming stream...";
	}

	if (hasRunningSubagents) {
		return "Waiting for subagents...";
	}

	if (lastMessage?.role === "assistant") {
		const statusReasoning = getLatestStatusReasoning(lastMessage.parts);
		if (statusReasoning) {
			return statusReasoning;
		}

		const runningTool = getRunningToolLabel(lastMessage.parts);
		if (runningTool) {
			return runningTool;
		}
	}

	if (status === "submitted") {
		return "Thinking...";
	}

	if (status === "streaming") {
		return hasAssistantText(lastMessage)
			? "Still streaming..."
			: "Streaming...";
	}

	return null;
}
