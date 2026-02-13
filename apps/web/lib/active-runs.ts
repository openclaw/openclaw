/**
 * Server-side singleton that manages agent child processes independently of
 * HTTP connections. Buffers SSE events, fans out to subscribers, and
 * persists assistant messages incrementally to disk.
 *
 * This decouples agent lifecycles from request lifecycles so:
 *  - Streams survive page reloads (process keeps running).
 *  - Messages are written to persistent sessions as they arrive.
 *  - New HTTP connections can re-attach to a running stream.
 */
import { type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	type AgentEvent,
	spawnAgentProcess,
	extractToolResult,
	buildToolOutput,
	parseAgentErrorMessage,
	parseErrorBody,
	parseErrorFromStderr,
} from "./agent-runner";

// ── Types ──

/** An SSE event object in the AI SDK v6 data stream wire format. */
export type SseEvent = Record<string, unknown> & { type: string };

/** Subscriber callback. Receives SSE events, or `null` when the run completes. */
export type RunSubscriber = (event: SseEvent | null) => void;

type AccumulatedMessage = {
	id: string;
	role: "assistant";
	textParts: string[];
	reasoningParts: string[];
	toolCalls: Map<
		string,
		{
			toolName: string;
			args: Record<string, unknown>;
			output?: Record<string, unknown>;
			errorText?: string;
		}
	>;
};

export type ActiveRun = {
	sessionId: string;
	childProcess: ChildProcess;
	eventBuffer: SseEvent[];
	subscribers: Set<RunSubscriber>;
	accumulated: AccumulatedMessage;
	status: "running" | "completed" | "error";
	startedAt: number;
	exitCode: number | null;
	abortController: AbortController;
	/** @internal debounced persistence timer */
	_persistTimer: ReturnType<typeof setTimeout> | null;
	/** @internal last time persistence was flushed */
	_lastPersistedAt: number;
};

// ── Constants ──

const PERSIST_INTERVAL_MS = 2_000;
const CLEANUP_GRACE_MS = 30_000;
const WEB_CHAT_DIR = join(homedir(), ".openclaw", "web-chat");
const INDEX_FILE = join(WEB_CHAT_DIR, "index.json");

// ── Singleton registry ──
// Store on globalThis so the Map survives Next.js HMR reloads in dev mode.
// Without this, hot-reloading any server module resets the Map, orphaning
// running child processes and dropping SSE streams mid-flight.

const GLOBAL_KEY = "__openclaw_activeRuns" as const;

const activeRuns: Map<string, ActiveRun> =
	(globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveRun> ??
	new Map<string, ActiveRun>();

(globalThis as Record<string, unknown>)[GLOBAL_KEY] = activeRuns;

// ── Public API ──

/** Retrieve an active or recently-completed run (within the grace period). */
export function getActiveRun(sessionId: string): ActiveRun | undefined {
	return activeRuns.get(sessionId);
}

/** Check whether a *running* (not just completed) run exists for a session. */
export function hasActiveRun(sessionId: string): boolean {
	const run = activeRuns.get(sessionId);
	return run !== undefined && run.status === "running";
}

/**
 * Subscribe to an active run's SSE events.
 *
 * When `replay` is true (default), all buffered events are replayed first
 * (synchronously), then live events follow. If the run already finished,
 * the subscriber is called with `null` after the replay.
 *
 * Returns an unsubscribe function, or `null` if no run exists.
 */
export function subscribeToRun(
	sessionId: string,
	callback: RunSubscriber,
	options?: { replay?: boolean },
): (() => void) | null {
	const run = activeRuns.get(sessionId);
	if (!run) {return null;}

	const replay = options?.replay ?? true;

	// Replay buffered events synchronously (safe — no event-loop yield).
	if (replay) {
		for (const event of run.eventBuffer) {
			callback(event);
		}
	}

	// If the run already finished, signal completion immediately.
	if (run.status !== "running") {
		callback(null);
		return () => {};
	}

	run.subscribers.add(callback);
	return () => {
		run.subscribers.delete(callback);
	};
}

/** Abort a running agent. Returns true if a run was actually aborted. */
export function abortRun(sessionId: string): boolean {
	const run = activeRuns.get(sessionId);
	if (!run || run.status !== "running") {return false;}
	run.abortController.abort();
	run.childProcess.kill("SIGTERM");
	return true;
}

/**
 * Start a new agent run for the given session.
 * Throws if a run is already active for this session.
 */
export function startRun(params: {
	sessionId: string;
	message: string;
	agentSessionId?: string;
}): ActiveRun {
	const { sessionId, message, agentSessionId } = params;

	const existing = activeRuns.get(sessionId);
	if (existing?.status === "running") {
		throw new Error("Active run already exists for this session");
	}
	// Clean up a finished run that's still in the grace period.
	if (existing) {cleanupRun(sessionId);}

	const abortController = new AbortController();
	const child = spawnAgentProcess(message, agentSessionId);

	const run: ActiveRun = {
		sessionId,
		childProcess: child,
		eventBuffer: [],
		subscribers: new Set(),
		accumulated: {
			id: `assistant-${sessionId}-${Date.now()}`,
			role: "assistant",
			textParts: [],
			reasoningParts: [],
			toolCalls: new Map(),
		},
		status: "running",
		startedAt: Date.now(),
		exitCode: null,
		abortController,
		_persistTimer: null,
		_lastPersistedAt: 0,
	};

	activeRuns.set(sessionId, run);

	// Wire abort signal → child process kill.
	const onAbort = () => child.kill("SIGTERM");
	if (abortController.signal.aborted) {
		child.kill("SIGTERM");
	} else {
		abortController.signal.addEventListener("abort", onAbort, {
			once: true,
		});
		child.on("close", () =>
			abortController.signal.removeEventListener("abort", onAbort),
		);
	}

	wireChildProcess(run);
	return run;
}

// ── Persistence helpers (called from route to persist user messages) ──

/** Save a user message to the session JSONL (called once at run start). */
export function persistUserMessage(
	sessionId: string,
	msg: { id: string; content: string; parts?: unknown[] },
): void {
	ensureDir();
	const filePath = join(WEB_CHAT_DIR, `${sessionId}.jsonl`);
	if (!existsSync(filePath)) {writeFileSync(filePath, "");}

	const line = JSON.stringify({
		id: msg.id,
		role: "user",
		content: msg.content,
		...(msg.parts ? { parts: msg.parts } : {}),
		timestamp: new Date().toISOString(),
	});

	// Avoid duplicates (e.g. retry).
	const existing = readFileSync(filePath, "utf-8");
	const lines = existing.split("\n").filter((l) => l.trim());
	const alreadySaved = lines.some((l) => {
		try {
			return JSON.parse(l).id === msg.id;
		} catch {
			return false;
		}
	});

	if (!alreadySaved) {
		writeFileSync(filePath, [...lines, line].join("\n") + "\n");
		updateIndex(sessionId, { incrementCount: 1 });
	}
}

// ── Internals ──

function ensureDir() {
	if (!existsSync(WEB_CHAT_DIR)) {
		mkdirSync(WEB_CHAT_DIR, { recursive: true });
	}
}

function updateIndex(
	sessionId: string,
	opts: { incrementCount?: number; title?: string },
) {
	try {
		if (!existsSync(INDEX_FILE)) {return;}
		const index = JSON.parse(
			readFileSync(INDEX_FILE, "utf-8"),
		) as Array<Record<string, unknown>>;
		const session = index.find((s) => s.id === sessionId);
		if (!session) {return;}
		session.updatedAt = Date.now();
		if (opts.incrementCount) {
			session.messageCount =
				((session.messageCount as number) || 0) + opts.incrementCount;
		}
		if (opts.title) {session.title = opts.title;}
		writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
	} catch {
		/* best-effort */
	}
}

// ── SSE event generation from child-process JSON lines ──

function wireChildProcess(run: ActiveRun): void {
	const child = run.childProcess;

	let idCounter = 0;
	const nextId = (prefix: string) =>
		`${prefix}-${Date.now()}-${++idCounter}`;

	let currentTextId = "";
	let currentReasoningId = "";
	let textStarted = false;
	let reasoningStarted = false;
	let everSentText = false;
	let statusReasoningActive = false;
	let agentErrorReported = false;
	const stderrChunks: string[] = [];

	/** Emit an SSE event: push to buffer + notify all subscribers. */
	const emit = (event: SseEvent) => {
		run.eventBuffer.push(event);
		for (const sub of run.subscribers) {
			try {
				sub(event);
			} catch {
				/* ignore subscriber errors */
			}
		}
		schedulePersist(run);
	};

	const closeReasoning = () => {
		if (reasoningStarted) {
			emit({ type: "reasoning-end", id: currentReasoningId });
			reasoningStarted = false;
			statusReasoningActive = false;
		}
	};

	const closeText = () => {
		if (textStarted) {
			emit({ type: "text-end", id: currentTextId });
			textStarted = false;
		}
	};

	const openStatusReasoning = (label: string) => {
		closeReasoning();
		closeText();
		currentReasoningId = nextId("status");
		emit({ type: "reasoning-start", id: currentReasoningId });
		emit({
			type: "reasoning-delta",
			id: currentReasoningId,
			delta: label,
		});
		reasoningStarted = true;
		statusReasoningActive = true;
	};

	const emitError = (message: string) => {
		closeReasoning();
		closeText();
		const tid = nextId("text");
		emit({ type: "text-start", id: tid });
		emit({ type: "text-delta", id: tid, delta: `[error] ${message}` });
		emit({ type: "text-end", id: tid });
		run.accumulated.textParts.push(`[error] ${message}`);
		everSentText = true;
	};

	// ── Parse stdout JSON lines ──

	const rl = createInterface({ input: child.stdout! });

	rl.on("line", (line: string) => {
		if (!line.trim()) {return;}

		let ev: AgentEvent;
		try {
			ev = JSON.parse(line) as AgentEvent;
		} catch {
			return;
		}

		// Lifecycle start
		if (
			ev.event === "agent" &&
			ev.stream === "lifecycle" &&
			ev.data?.phase === "start"
		) {
			openStatusReasoning("Preparing response...");
		}

		// Thinking / reasoning
		if (ev.event === "agent" && ev.stream === "thinking") {
			const delta =
				typeof ev.data?.delta === "string"
					? ev.data.delta
					: undefined;
			if (delta) {
				if (statusReasoningActive) {closeReasoning();}
				if (!reasoningStarted) {
					currentReasoningId = nextId("reasoning");
					emit({
						type: "reasoning-start",
						id: currentReasoningId,
					});
					reasoningStarted = true;
				}
				emit({
					type: "reasoning-delta",
					id: currentReasoningId,
					delta,
				});
				run.accumulated.reasoningParts.push(delta);
			}
		}

		// Assistant text
		if (ev.event === "agent" && ev.stream === "assistant") {
			const delta =
				typeof ev.data?.delta === "string"
					? ev.data.delta
					: undefined;
			if (delta) {
				closeReasoning();
				if (!textStarted) {
					currentTextId = nextId("text");
					emit({ type: "text-start", id: currentTextId });
					textStarted = true;
				}
				everSentText = true;
				emit({ type: "text-delta", id: currentTextId, delta });
				run.accumulated.textParts.push(delta);
			}
			// Media URLs
			const mediaUrls = ev.data?.mediaUrls;
			if (Array.isArray(mediaUrls)) {
				for (const url of mediaUrls) {
					if (typeof url === "string" && url.trim()) {
						closeReasoning();
						if (!textStarted) {
							currentTextId = nextId("text");
							emit({
								type: "text-start",
								id: currentTextId,
							});
							textStarted = true;
						}
						everSentText = true;
						const md = `\n![media](${url.trim()})\n`;
						emit({
							type: "text-delta",
							id: currentTextId,
							delta: md,
						});
						run.accumulated.textParts.push(md);
					}
				}
			}
			// Agent error inline (stopReason=error)
			if (
				typeof ev.data?.stopReason === "string" &&
				ev.data.stopReason === "error" &&
				typeof ev.data?.errorMessage === "string" &&
				!agentErrorReported
			) {
				agentErrorReported = true;
				emitError(parseErrorBody(ev.data.errorMessage));
			}
		}

		// Tool events
		if (ev.event === "agent" && ev.stream === "tool") {
			const phase =
				typeof ev.data?.phase === "string"
					? ev.data.phase
					: undefined;
			const toolCallId =
				typeof ev.data?.toolCallId === "string"
					? ev.data.toolCallId
					: "";
			const toolName =
				typeof ev.data?.name === "string" ? ev.data.name : "";

			if (phase === "start") {
				closeReasoning();
				closeText();
				const args =
					ev.data?.args && typeof ev.data.args === "object"
						? (ev.data.args as Record<string, unknown>)
						: {};
				emit({ type: "tool-input-start", toolCallId, toolName });
				emit({
					type: "tool-input-available",
					toolCallId,
					toolName,
					input: args,
				});
				run.accumulated.toolCalls.set(toolCallId, {
					toolName,
					args,
				});
			} else if (phase === "result") {
				const isError = ev.data?.isError === true;
				const result = extractToolResult(ev.data?.result);
				if (isError) {
					const errorText =
						result?.text ||
						(result?.details?.error as string | undefined) ||
						"Tool execution failed";
					emit({
						type: "tool-output-error",
						toolCallId,
						errorText,
					});
					const tc = run.accumulated.toolCalls.get(toolCallId);
					if (tc) {tc.errorText = errorText;}
				} else {
					const output = buildToolOutput(result);
					emit({
						type: "tool-output-available",
						toolCallId,
						output,
					});
					const tc = run.accumulated.toolCalls.get(toolCallId);
					if (tc) {tc.output = output;}
				}
			}
		}

		// Compaction
		if (ev.event === "agent" && ev.stream === "compaction") {
			const phase =
				typeof ev.data?.phase === "string"
					? ev.data.phase
					: undefined;
			if (phase === "start") {
				openStatusReasoning("Optimizing session context...");
			} else if (phase === "end") {
				if (statusReasoningActive) {
					if (ev.data?.willRetry === true) {
						emit({
							type: "reasoning-delta",
							id: currentReasoningId,
							delta: "\nRetrying with compacted context...",
						});
					} else {
						closeReasoning();
					}
				}
			}
		}

		// Lifecycle end
		if (
			ev.event === "agent" &&
			ev.stream === "lifecycle" &&
			ev.data?.phase === "end"
		) {
			closeReasoning();
			closeText();
		}

		// Lifecycle error
		if (
			ev.event === "agent" &&
			ev.stream === "lifecycle" &&
			ev.data?.phase === "error" &&
			!agentErrorReported
		) {
			const msg = parseAgentErrorMessage(ev.data);
			if (msg) {
				agentErrorReported = true;
				emitError(msg);
			}
		}

		// Top-level error event
		if (ev.event === "error" && !agentErrorReported) {
			const msg = parseAgentErrorMessage(
				ev.data ??
					(ev as unknown as Record<string, unknown>),
			);
			if (msg) {
				agentErrorReported = true;
				emitError(msg);
			}
		}
	});

	// ── Child process exit ──

	child.on("close", (code) => {
		if (!agentErrorReported && stderrChunks.length > 0) {
			const stderr = stderrChunks.join("").trim();
			const msg = parseErrorFromStderr(stderr);
			if (msg) {
				agentErrorReported = true;
				emitError(msg);
			}
		}

		closeReasoning();
		if (!everSentText) {
			const tid = nextId("text");
			emit({ type: "text-start", id: tid });
			const errMsg =
				code !== null && code !== 0
					? `[error] Agent exited with code ${code}. Check server logs for details.`
					: "[error] No response from agent.";
			emit({ type: "text-delta", id: tid, delta: errMsg });
			emit({ type: "text-end", id: tid });
			run.accumulated.textParts.push(errMsg);
		} else {
			closeText();
		}

		run.status = code === 0 || code === null ? "completed" : "error";
		run.exitCode = code;

		// Final persistence flush (removes _streaming flag).
		flushPersistence(run);

		// Signal completion to all subscribers.
		for (const sub of run.subscribers) {
			try {
				sub(null);
			} catch {
				/* ignore */
			}
		}
		run.subscribers.clear();

		// Clean up run state after a grace period so reconnections
		// within that window still get the buffered events.
		setTimeout(() => cleanupRun(run.sessionId), CLEANUP_GRACE_MS);
	});

	child.on("error", (err) => {
		console.error("[active-runs] Child process error:", err);
		emitError(`Failed to start agent: ${err.message}`);
		run.status = "error";
		flushPersistence(run);
		for (const sub of run.subscribers) {
			try {
				sub(null);
			} catch {
				/* ignore */
			}
		}
		run.subscribers.clear();
		setTimeout(() => cleanupRun(run.sessionId), CLEANUP_GRACE_MS);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stderrChunks.push(text);
		console.error("[active-runs stderr]", text);
	});
}

// ── Debounced persistence ──

function schedulePersist(run: ActiveRun) {
	if (run._persistTimer) {return;}
	const elapsed = Date.now() - run._lastPersistedAt;
	const delay = Math.max(0, PERSIST_INTERVAL_MS - elapsed);
	run._persistTimer = setTimeout(() => {
		run._persistTimer = null;
		flushPersistence(run);
	}, delay);
}

function flushPersistence(run: ActiveRun) {
	if (run._persistTimer) {
		clearTimeout(run._persistTimer);
		run._persistTimer = null;
	}
	run._lastPersistedAt = Date.now();

	const text = run.accumulated.textParts.join("");
	if (
		!text &&
		run.accumulated.toolCalls.size === 0 &&
		run.accumulated.reasoningParts.length === 0
	) {
		return; // Nothing to persist yet.
	}

	// Build parts array matching the UIMessage format the frontend expects.
	const parts: Array<Record<string, unknown>> = [];

	if (run.accumulated.reasoningParts.length > 0) {
		parts.push({
			type: "reasoning",
			text: run.accumulated.reasoningParts.join(""),
		});
	}

	for (const [toolCallId, tc] of run.accumulated.toolCalls) {
		parts.push({
			type: "tool-invocation",
			toolCallId,
			toolName: tc.toolName,
			args: tc.args,
			...(tc.output ? { result: tc.output } : {}),
			...(tc.errorText ? { errorText: tc.errorText } : {}),
		});
	}

	if (text) {
		parts.push({ type: "text", text });
	}

	const isStillRunning = run.status === "running";
	const message: Record<string, unknown> = {
		id: run.accumulated.id,
		role: "assistant",
		content: text,
		parts,
		timestamp: new Date().toISOString(),
	};
	if (isStillRunning) {
		message._streaming = true;
	}

	try {
		upsertMessage(run.sessionId, message);
	} catch (err) {
		console.error("[active-runs] Persistence error:", err);
	}
}

/**
 * Upsert a single message into the session JSONL.
 * If a line with the same `id` already exists it is replaced; otherwise appended.
 */
function upsertMessage(
	sessionId: string,
	message: Record<string, unknown>,
) {
	ensureDir();
	const fp = join(WEB_CHAT_DIR, `${sessionId}.jsonl`);
	if (!existsSync(fp)) {writeFileSync(fp, "");}

	const msgId = message.id as string;
	const content = readFileSync(fp, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim());

	let found = false;
	const updated = lines.map((line) => {
		try {
			const parsed = JSON.parse(line);
			if (parsed.id === msgId) {
				found = true;
				return JSON.stringify(message);
			}
		} catch {
			/* keep as-is */
		}
		return line;
	});

	if (!found) {
		updated.push(JSON.stringify(message));
		updateIndex(sessionId, { incrementCount: 1 });
	} else {
		updateIndex(sessionId, {});
	}

	writeFileSync(fp, updated.join("\n") + "\n");
}

function cleanupRun(sessionId: string) {
	const run = activeRuns.get(sessionId);
	if (!run) {return;}
	if (run._persistTimer) {clearTimeout(run._persistTimer);}
	activeRuns.delete(sessionId);
}
