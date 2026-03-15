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
		message.parts.some(
			(part) =>
				part.type === "text" &&
				typeof (part as { text?: unknown }).text === "string" &&
				(part as { text: string }).text.length > 0,
		),
	);
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
