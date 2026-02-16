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

type AccumulatedPart =
	| { type: "reasoning"; text: string }
	| {
			type: "tool-invocation";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			result?: Record<string, unknown>;
			errorText?: string;
		}
	| { type: "text"; text: string };

type AccumulatedMessage = {
	id: string;
	role: "assistant";
	/** Ordered parts preserving the interleaving of reasoning, tools, and text. */
	parts: AccumulatedPart[];
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

/** Return the session IDs of all currently running agent runs. */
export function getRunningSessionIds(): string[] {
	const ids: string[] = [];
	for (const [sessionId, run] of activeRuns) {
		if (run.status === "running") {
			ids.push(sessionId);
		}
	}
	return ids;
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

	// Fallback: if the child doesn't exit within 5 seconds after
	// SIGTERM (e.g. the CLI's best-effort chat.abort RPC hangs),
	// send SIGKILL to force-terminate.
	const killTimer = setTimeout(() => {
		try {
			if (run.status === "running") {
				run.childProcess.kill("SIGKILL");
			}
		} catch { /* already dead */ }
	}, 5_000);
	run.childProcess.once("close", () => clearTimeout(killTimer));

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
			parts: [],
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

	// ── Ordered accumulation tracking (preserves interleaving for persistence) ──
	let accTextIdx = -1;
	let accReasoningIdx = -1;
	const accToolMap = new Map<string, number>();

	const accAppendReasoning = (delta: string) => {
		if (accReasoningIdx < 0) {
			run.accumulated.parts.push({ type: "reasoning", text: delta });
			accReasoningIdx = run.accumulated.parts.length - 1;
		} else {
			(run.accumulated.parts[accReasoningIdx] as { type: "reasoning"; text: string }).text += delta;
		}
	};

	const accAppendText = (delta: string) => {
		if (accTextIdx < 0) {
			run.accumulated.parts.push({ type: "text", text: delta });
			accTextIdx = run.accumulated.parts.length - 1;
		} else {
			(run.accumulated.parts[accTextIdx] as { type: "text"; text: string }).text += delta;
		}
	};

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
		accReasoningIdx = -1;
	};

	const closeText = () => {
		if (textStarted) {
			emit({ type: "text-end", id: currentTextId });
			textStarted = false;
		}
		accTextIdx = -1;
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
		accAppendReasoning(label);
	};

	const emitError = (message: string) => {
		closeReasoning();
		closeText();
		const tid = nextId("text");
		emit({ type: "text-start", id: tid });
		emit({ type: "text-delta", id: tid, delta: `[error] ${message}` });
		emit({ type: "text-end", id: tid });
		accAppendText(`[error] ${message}`);
		accTextIdx = -1; // error text is self-contained
		everSentText = true;
	};

	// ── Parse stdout JSON lines ──

	const rl = createInterface({ input: child.stdout! });

	// Prevent unhandled 'error' events on the readline interface.
	// When the child process fails to start (e.g. ENOENT — missing script)
	// the stdout pipe is destroyed and readline re-emits the error.  Without
	// this handler Node.js throws "Unhandled 'error' event" which crashes
	// the API route instead of surfacing a clean message to the user.
	rl.on("error", () => {
		// Swallow — the child 'error' / 'close' handlers take care of
		// emitting user-visible diagnostics.
	});

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
				accAppendReasoning(delta);
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
				accAppendText(delta);
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
						accAppendText(md);
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
				// Accumulate tool start in ordered parts
				run.accumulated.parts.push({
					type: "tool-invocation",
					toolCallId,
					toolName,
					args,
				});
				accToolMap.set(toolCallId, run.accumulated.parts.length - 1);
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
					// Update the accumulated tool part
					const idx = accToolMap.get(toolCallId);
					if (idx !== undefined) {
						const part = run.accumulated.parts[idx];
						if (part.type === "tool-invocation") {
							part.errorText = errorText;
						}
					}
				} else {
					const output = buildToolOutput(result);
					emit({
						type: "tool-output-available",
						toolCallId,
						output,
					});
					// Update the accumulated tool part
					const idx = accToolMap.get(toolCallId);
					if (idx !== undefined) {
						const part = run.accumulated.parts[idx];
						if (part.type === "tool-invocation") {
							part.result = output;
						}
					}
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
						const retryDelta = "\nRetrying with compacted context...";
						emit({
							type: "reasoning-delta",
							id: currentReasoningId,
							delta: retryDelta,
						});
						accAppendReasoning(retryDelta);
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
			accAppendText(errMsg);
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

	const parts = run.accumulated.parts;
	if (parts.length === 0) {
		return; // Nothing to persist yet.
	}

	// Build content text from text parts for the backwards-compatible
	// content field (used when parts are not available).
	const text = parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");

	const isStillRunning = run.status === "running";
	const message: Record<string, unknown> = {
		id: run.accumulated.id,
		role: "assistant",
		content: text,
		parts, // Ordered parts — preserves interleaving of reasoning, tools, text
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
