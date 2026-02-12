import type { UIMessage } from "ai";
import { runAgent, type ToolResult } from "@/lib/agent-runner";
import { resolveAgentWorkspacePrefix } from "@/lib/workspace";

// Force Node.js runtime (required for child_process)
export const runtime = "nodejs";

// Allow streaming responses up to 10 minutes
export const maxDuration = 600;

/**
 * Build a flat output object from the agent's tool result so the frontend
 * can render tool output text, exit codes, etc.
 */
function buildToolOutput(
	result?: ToolResult,
): Record<string, unknown> {
	if (!result) {return {};}
	const out: Record<string, unknown> = {};
	if (result.text) {out.text = result.text;}
	if (result.details) {
		// Forward useful details (exit code, duration, status, cwd)
		for (const key of [
			"exitCode",
			"status",
			"durationMs",
			"cwd",
			"error",
			"reason",
		]) {
			if (result.details[key] !== undefined)
				{out[key] = result.details[key];}
		}
	}
	return out;
}

export async function POST(req: Request) {
	const { messages, sessionId }: { messages: UIMessage[]; sessionId?: string } =
		await req.json();

	// Extract the latest user message text
	const lastUserMessage = messages.filter((m) => m.role === "user").pop();
	const userText =
		lastUserMessage?.parts
			?.filter(
				(p): p is { type: "text"; text: string } => p.type === "text",
			)
			.map((p) => p.text)
			.join("\n") ?? "";

	if (!userText.trim()) {
		return new Response("No message provided", { status: 400 });
	}

	// Resolve workspace file paths to be agent-cwd-relative.
	// Tree paths are workspace-root-relative (e.g. "knowledge/leads/foo.md"),
	// but the agent runs from the repo root and needs "dench/knowledge/leads/foo.md".
	let agentMessage = userText;
	const wsPrefix = resolveAgentWorkspacePrefix();
	if (wsPrefix) {
		agentMessage = userText.replace(
			/\[Context: workspace file '([^']+)'\]/,
			`[Context: workspace file '${wsPrefix}/$1']`,
		);
	}

	// Create a custom SSE stream using the AI SDK v6 data stream wire format.
	// DefaultChatTransport parses these events into UIMessage parts automatically.
	const encoder = new TextEncoder();
	let closed = false;
	const abortController = new AbortController();
	const stream = new ReadableStream({
		async start(controller) {
			// Use incrementing IDs so multi-round reasoning/text cycles get
			// unique part IDs (avoids conflicts in the AI SDK transport).
			let idCounter = 0;
			const nextId = (prefix: string) =>
				`${prefix}-${Date.now()}-${++idCounter}`;

			let currentTextId = "";
			let currentReasoningId = "";
			let textStarted = false;
			let reasoningStarted = false;
			// Track whether ANY text was ever sent across the full run.
			// onLifecycleEnd closes the text part (textStarted→false), so
			// onClose can't rely on textStarted alone to detect "no output".
			let everSentText = false;

			/** Write an SSE event; silently no-ops if the stream was already cancelled. */
			const writeEvent = (data: unknown) => {
				if (closed) {return;}
				const json = JSON.stringify(data);
				controller.enqueue(encoder.encode(`data: ${json}\n\n`));
			};

			/** Close the reasoning part if open. */
			const closeReasoning = () => {
				if (reasoningStarted) {
					writeEvent({
						type: "reasoning-end",
						id: currentReasoningId,
					});
					reasoningStarted = false;
				}
			};

			/** Close the text part if open. */
			const closeText = () => {
				if (textStarted) {
					writeEvent({ type: "text-end", id: currentTextId });
					textStarted = false;
				}
			};

			try {
				await runAgent(agentMessage, abortController.signal, {
					onThinkingDelta: (delta) => {
						if (!reasoningStarted) {
							currentReasoningId = nextId("reasoning");
							writeEvent({
								type: "reasoning-start",
								id: currentReasoningId,
							});
							reasoningStarted = true;
						}
						writeEvent({
							type: "reasoning-delta",
							id: currentReasoningId,
							delta,
						});
					},

					onTextDelta: (delta) => {
						// Close reasoning once text starts streaming
						closeReasoning();

						if (!textStarted) {
							currentTextId = nextId("text");
							writeEvent({
								type: "text-start",
								id: currentTextId,
							});
							textStarted = true;
						}
						everSentText = true;
						writeEvent({
							type: "text-delta",
							id: currentTextId,
							delta,
						});
					},

					onToolStart: (toolCallId, toolName, args) => {
						// Close open reasoning/text parts before tool events
						closeReasoning();
						closeText();

						writeEvent({
							type: "tool-input-start",
							toolCallId,
							toolName,
						});
						// Include actual tool arguments so the frontend can
						// display what the tool is doing (command, path, etc.)
						writeEvent({
							type: "tool-input-available",
							toolCallId,
							toolName,
							input: args ?? {},
						});
					},

					onToolEnd: (
						toolCallId,
						_toolName,
						isError,
						result,
					) => {
						if (isError) {
							const errorText =
								result?.text ||
								(result?.details?.error as
									| string
									| undefined) ||
								"Tool execution failed";
							writeEvent({
								type: "tool-output-error",
								toolCallId,
								errorText,
							});
						} else {
							// Include the actual tool output (text, exit code, etc.)
							writeEvent({
								type: "tool-output-available",
								toolCallId,
								output: buildToolOutput(result),
							});
						}
					},

					onLifecycleEnd: () => {
						closeReasoning();
						closeText();
					},

					onAgentError: (message) => {
						// Surface agent-level errors (API 402, rate limits, etc.)
						// as visible text in the chat so the user sees what happened.
						closeReasoning();
						closeText();

						currentTextId = nextId("text");
						writeEvent({
							type: "text-start",
							id: currentTextId,
						});
						writeEvent({
							type: "text-delta",
							id: currentTextId,
							delta: `[error] ${message}`,
						});
						writeEvent({
							type: "text-end",
							id: currentTextId,
						});
						textStarted = false;
						everSentText = true;
					},

					onError: (err) => {
						console.error("[chat] Agent error:", err);
						closeReasoning();
						closeText();

						currentTextId = nextId("text");
						writeEvent({
							type: "text-start",
							id: currentTextId,
						});
						textStarted = true;
						everSentText = true;
						writeEvent({
							type: "text-delta",
							id: currentTextId,
							delta: `[error] Failed to start agent: ${err.message}`,
						});
						writeEvent({ type: "text-end", id: currentTextId });
						textStarted = false;
					},

					onClose: (_code) => {
						closeReasoning();
						if (!everSentText) {
							// No text was ever sent during the entire run
							currentTextId = nextId("text");
							writeEvent({
								type: "text-start",
								id: currentTextId,
							});
							const msg =
								_code !== null && _code !== 0
									? `[error] Agent exited with code ${_code}. Check server logs for details.`
									: "[error] No response from agent.";
							writeEvent({
								type: "text-delta",
								id: currentTextId,
								delta: msg,
							});
							writeEvent({
								type: "text-end",
								id: currentTextId,
							});
						} else {
							// Ensure any still-open text part is closed
							closeText();
						}
					},
				}, sessionId ? { sessionId } : undefined);
			} catch (error) {
				console.error("[chat] Stream error:", error);
				writeEvent({
					type: "error",
					errorText:
						error instanceof Error
							? error.message
							: String(error),
				});
			} finally {
				if (!closed) {
					closed = true;
					controller.close();
				}
			}
		},
		cancel() {
			// Client disconnected (e.g. user hit stop) — tear down gracefully.
			closed = true;
			abortController.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
