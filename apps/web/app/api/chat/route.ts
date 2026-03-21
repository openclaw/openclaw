import type { UIMessage } from "ai";
import {
	resolveActiveAgentId,
	resolveAgentWorkspacePrefix,
	resolveOpenClawStateDir,
} from "@/lib/workspace";
import {
	startRun,
	startSubscribeRun,
	hasActiveRun,
	getActiveRun,
	subscribeToRun,
	persistUserMessage,
	persistSubscribeUserMessage,
	reactivateSubscribeRun,
	type SseEvent,
} from "@/lib/active-runs";
import { trackServer } from "@/lib/telemetry";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionMeta } from "@/app/api/web-sessions/shared";

export const runtime = "nodejs";

function deriveSubagentInfo(sessionKey: string): { parentSessionId: string; task: string } | null {
	const registryPath = join(resolveOpenClawStateDir(), "subagents", "runs.json");
	if (!existsSync(registryPath)) {return null;}
	try {
		const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
			runs?: Record<string, Record<string, unknown>>;
		};
		for (const entry of Object.values(raw.runs ?? {})) {
			if (entry.childSessionKey !== sessionKey) {continue;}
			const requester = typeof entry.requesterSessionKey === "string" ? entry.requesterSessionKey : "";
			const match = requester.match(/^agent:[^:]+:web:(.+)$/);
			const parentSessionId = match?.[1] ?? "";
			const task = typeof entry.task === "string" ? entry.task : "";
			return { parentSessionId, task };
		}
	} catch {
		// ignore
	}
	return null;
}

function normalizeLiveStreamEvent(event: SseEvent): SseEvent {
	// AI SDK's UI stream schema does not define `tool-output-partial`.
	// It expects repeated `tool-output-available` chunks with
	// `preliminary: true` while the tool is still running.
	if (event.type === "tool-output-partial") {
		return {
			type: "tool-output-available",
			toolCallId: event.toolCallId,
			output: event.output,
			preliminary: true,
		};
	}

	return event;
}

export async function POST(req: Request) {
	const {
		messages,
		sessionId,
		sessionKey,
		distinctId,
		userHtml,
	}: { messages: UIMessage[]; sessionId?: string; sessionKey?: string; distinctId?: string; userHtml?: string } = await req.json();

	const lastUserMessage = messages.filter((m) => m.role === "user").pop();
	const userText =
		lastUserMessage?.parts
			?.filter(
				(p): p is { type: "text"; text: string } =>
					p.type === "text",
			)
			.map((p) => p.text)
			.join("\n") ?? "";

	// Extract image file parts for vision-capable models
	type FilePart = { type: "file"; mediaType: string; url: string; filename?: string };
	const imageAttachments: Array<{ mediaType: string; data: string }> =
		(lastUserMessage?.parts ?? [])
			.filter((p): p is FilePart =>
				(p as FilePart).type === "file" &&
				typeof (p as FilePart).mediaType === "string" &&
				(p as FilePart).mediaType.startsWith("image/") &&
				typeof (p as FilePart).url === "string",
			)
			.map((p) => ({ mediaType: p.mediaType, data: p.url }));

	if (!userText.trim() && imageAttachments.length === 0) {
		return new Response("No message provided", { status: 400 });
	}

	trackServer(
		"chat_message_sent",
		{
			message_length: userText.length,
			is_subagent: typeof sessionKey === "string" && sessionKey.includes(":subagent:"),
		},
		distinctId,
	);

	const isSubagentSession = typeof sessionKey === "string" && sessionKey.includes(":subagent:");

	if (!isSubagentSession && sessionId && hasActiveRun(sessionId)) {
		return new Response("Active run in progress", { status: 409 });
	}
	if (isSubagentSession && sessionKey) {
		const existingRun = getActiveRun(sessionKey);
		if (existingRun?.status === "running") {
			return new Response("Active subagent run in progress", { status: 409 });
		}
	}

	let agentMessage = userText;
	const wsPrefix = resolveAgentWorkspacePrefix();
	if (wsPrefix) {
		agentMessage = agentMessage.replace(
			/\[Context: workspace file '([^']+)'\]/,
			`[Context: workspace file '${wsPrefix}/$1']`,
		);
		agentMessage = agentMessage.replace(
			/\[Attached files: (.+?)\]/,
			(_, paths: string) => {
				const prefixed = paths
					.split(", ")
					.map((p: string) => p.trim())
					.filter(Boolean)
					.map((p: string) => p.startsWith("/") ? p : `${wsPrefix}/${p}`)
					.join(", ");
				return `[Attached files: ${prefixed}]`;
			},
		);
	}

	const runKey = isSubagentSession && sessionKey ? sessionKey : (sessionId as string);

	if (isSubagentSession && sessionKey && lastUserMessage) {
		let run = getActiveRun(sessionKey);
		if (!run) {
			const info = deriveSubagentInfo(sessionKey);
			if (!info) {
				return new Response("Subagent not found", { status: 404 });
			}
			run = startSubscribeRun({
				sessionKey,
				parentSessionId: info.parentSessionId,
				task: info.task,
			});
		}
		await persistSubscribeUserMessage(sessionKey, {
			id: lastUserMessage.id,
			text: userText,
		});
		reactivateSubscribeRun(sessionKey, agentMessage);
	} else if (sessionId && lastUserMessage) {
		await persistUserMessage(sessionId, {
			id: lastUserMessage.id,
			content: userText,
			parts: lastUserMessage.parts as unknown[],
			html: userHtml,
		});

		const sessionMeta = getSessionMeta(sessionId);
		const effectiveAgentId =
			sessionMeta?.workspaceAgentId
			?? resolveActiveAgentId();

		try {
			startRun({
				sessionId,
				message: agentMessage,
				agentSessionId: sessionId,
				overrideAgentId: effectiveAgentId,
				attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
			});
		} catch (err) {
			return new Response(
				err instanceof Error ? err.message : String(err),
				{ status: 500 },
			);
		}
	}

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			if (!runKey) {
				controller.close();
				return;
			}

			keepalive = setInterval(() => {
				if (closed) {return;}
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch { /* ignore enqueue errors on closed stream */ }
			}, 15_000);

		unsubscribe = subscribeToRun(
			runKey,
			(event: SseEvent | null) => {
				if (closed) {return;}
				if (event === null) {
						closed = true;
						if (keepalive) { clearInterval(keepalive); keepalive = null; }
						try { controller.close(); } catch { /* already closed */ }
						return;
					}
					try {
						const json = JSON.stringify(normalizeLiveStreamEvent(event));
						controller.enqueue(encoder.encode(`data: ${json}\n\n`));
					} catch { /* ignore */ }
				},
				{ replay: false },
			);

			if (!unsubscribe) {
				closed = true;
				if (keepalive) { clearInterval(keepalive); keepalive = null; }
				controller.close();
			}
		},
		cancel() {
			closed = true;
			if (keepalive) { clearInterval(keepalive); keepalive = null; }
			unsubscribe?.();
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
