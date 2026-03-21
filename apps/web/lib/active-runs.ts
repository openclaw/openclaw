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
import { createInterface } from "node:readline";
import { join, resolve, basename } from "node:path";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import {
	access,
	mkdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { resolveWebChatDir, resolveOpenClawStateDir, resolveActiveAgentId } from "./workspace";
import {
	type AgentProcessHandle,
	type AgentEvent,
	spawnAgentProcess,
	spawnAgentSubscribeProcess,
	spawnAgentStartForSession,
	callGatewayRpc,
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
	childProcess: AgentProcessHandle;
	eventBuffer: SseEvent[];
	subscribers: Set<RunSubscriber>;
	accumulated: AccumulatedMessage;
	status: "running" | "waiting-for-subagents" | "completed" | "error";
	startedAt: number;
	exitCode: number | null;
	abortController: AbortController;
	/** @internal debounced persistence timer */
	_persistTimer: ReturnType<typeof setTimeout> | null;
	/** @internal last time persistence was flushed */
	_lastPersistedAt: number;
	/** @internal last globalSeq seen from the gateway event stream */
	lastGlobalSeq: number;
	/** @internal subscribe child process for waiting-for-subagents continuation */
	_subscribeProcess?: AgentProcessHandle | null;
	/** @internal retry timer for subscribe stream restarts */
	_subscribeRetryTimer?: ReturnType<typeof setTimeout> | null;
	/** @internal consecutive subscribe restart attempts without a received event */
	_subscribeRetryAttempt?: number;
	/** Full gateway session key (used for subagent subscribe-only runs) */
	sessionKey?: string;
	/** Parent web session ID (for subagent runs) */
	parentSessionId?: string;
	/** Subagent task description */
	task?: string;
	/** Subagent label */
	label?: string;
	/** True for subscribe-only runs (subagents) that don't own the agent process */
	isSubscribeOnly?: boolean;
	/** Set when lifecycle/end is received; defers finalization until subscribe close */
	_lifecycleEnded?: boolean;
	/** Safety timer to finalize if subscribe process hangs after lifecycle/end */
	_finalizeTimer?: ReturnType<typeof setTimeout> | null;
	/** @internal short reconciliation window before waiting-run completion */
	_waitingFinalizeTimer?: ReturnType<typeof setTimeout> | null;
	/** Agent ID captured at run creation time. Used for abort, transcript enrichment. */
	pinnedAgentId?: string;
	/** Full gateway session key captured at run creation time. */
	pinnedSessionKey?: string;
};

// ── Constants ──

const PERSIST_INTERVAL_MS = 2_000;
const CLEANUP_GRACE_MS = 30_000;
const SUBSCRIBE_CLEANUP_GRACE_MS = 24 * 60 * 60_000;
const SUBSCRIBE_RETRY_BASE_MS = 300;
const SUBSCRIBE_RETRY_MAX_MS = 5_000;
const SUBSCRIBE_LIFECYCLE_END_GRACE_MS = 750;
const WAITING_FINALIZE_RECONCILE_MS = 5_000;
const MAX_WAITING_DURATION_MS = 10 * 60_000;
const SUBAGENT_REGISTRY_STALENESS_MS = 15 * 60_000;

const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Detect leaked silent-reply fragments in finalized text parts.
 * The agent runner suppresses full "NO_REPLY" tokens, but during streaming
 * the model may emit a partial prefix (e.g. "NO") before the full token is
 * assembled and caught. This catches both the full token and known partial
 * prefixes so they don't leak into persisted/displayed messages.
 */
function isLeakedSilentReplyToken(text: string): boolean {
	const t = text.trim();
	if (!t) {return false;}
	if (new RegExp(`^${SILENT_REPLY_TOKEN}\\W*$`).test(t)) {return true;}
	if (SILENT_REPLY_TOKEN.startsWith(t) && t.length >= 2 && t.length < SILENT_REPLY_TOKEN.length) {return true;}
	return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function resolveModelLabel(provider: unknown, model: unknown): string | null {
	if (typeof model !== "string" || !model.trim()) { return null; }
	const m = model.trim();
	if (typeof provider === "string" && provider.trim()) {
		const p = provider.trim();
		return m.toLowerCase().startsWith(`${p.toLowerCase()}/`) ? m : `${p}/${m}`;
	}
	return m;
}

function extractAssistantTextFromChatPayload(
	data: Record<string, unknown> | undefined,
): string {
	if (!data) {
		return "";
	}
	const state = typeof data.state === "string" ? data.state : "";
	if (state !== "final") {
		return "";
	}
	const message = asRecord(data.message);
	if (!message || message.role !== "assistant") {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const chunks: string[] = [];
	for (const part of content) {
		const rec = asRecord(part);
		if (!rec) {
			continue;
		}
		const type = typeof rec.type === "string" ? rec.type : "";
		if ((type === "text" || type === "output_text") && typeof rec.text === "string") {
			chunks.push(rec.text);
		}
	}
	return chunks.join("");
}
// Evaluated per-call so it tracks profile switches at runtime.
function webChatDir(): string { return resolveWebChatDir(); }
function indexFile(): string { return join(webChatDir(), "index.json"); }

// ── Singleton registry ──
// Store on globalThis so the Map survives Next.js HMR reloads in dev mode.
// Without this, hot-reloading any server module resets the Map, orphaning
// running child processes and dropping SSE streams mid-flight.

const GLOBAL_KEY = "__openclaw_activeRuns" as const;

const activeRuns: Map<string, ActiveRun> =
	(globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveRun> ??
	new Map<string, ActiveRun>();

(globalThis as Record<string, unknown>)[GLOBAL_KEY] = activeRuns;

const fileMutationQueues = new Map<string, Promise<void>>();

async function pathExistsAsync(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build a `.jsonl` path for `sessionId` that is guaranteed to live inside
 * `webChatDir()`.  `basename()` strips any directory-traversal segments.
 */
function safeSessionFilePath(sessionId: string): string {
	const dir = resolve(webChatDir());
	const safe = resolve(dir, basename(sessionId) + ".jsonl");
	if (!safe.startsWith(dir + "/")) {
		throw new Error("Invalid session id");
	}
	return safe;
}

async function queueFileMutation<T>(
	filePath: string,
	mutate: () => Promise<T>,
): Promise<T> {
	const previous = fileMutationQueues.get(filePath) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(mutate);
	const settled = next.then(() => undefined, () => undefined);
	fileMutationQueues.set(filePath, settled);
	try {
		return await next;
	} finally {
		if (fileMutationQueues.get(filePath) === settled) {
			fileMutationQueues.delete(filePath);
		}
	}
}

// ── Public API ──

/** Retrieve an active or recently-completed run (within the grace period). */
export function getActiveRun(sessionId: string): ActiveRun | undefined {
	return activeRuns.get(sessionId);
}

/** Check whether a *running* (not just completed) run exists for a session. */
export function hasActiveRun(sessionId: string): boolean {
	const run = activeRuns.get(sessionId);
	return run !== undefined && (run.status === "running" || run.status === "waiting-for-subagents");
}

/** Return the session IDs of all currently running agent runs. */
export function getRunningSessionIds(): string[] {
	const ids: string[] = [];
	for (const [sessionId, run] of activeRuns) {
		if (run.status === "running" || run.status === "waiting-for-subagents") {
			ids.push(sessionId);
		}
	}
	return ids;
}

function hasRunningSubagentsInMemory(parentWebSessionId: string): boolean {
	for (const [_key, run] of activeRuns) {
		if (run.isSubscribeOnly && run.parentSessionId === parentWebSessionId && run.status === "running") {
			return true;
		}
	}
	return false;
}

/** Check if any subagent sessions are still running for a parent web session. */
export async function hasRunningSubagentsForParent(parentWebSessionId: string): Promise<boolean> {
	if (hasRunningSubagentsInMemory(parentWebSessionId)) {
		return true;
	}
	// Fallback: check the gateway disk registry
	const registryPath = join(resolveOpenClawStateDir(), "subagents", "runs.json");
	if (!await pathExistsAsync(registryPath)) {return false;}
	try {
		const raw = JSON.parse(await readFile(registryPath, "utf-8")) as {
			runs?: Record<string, Record<string, unknown>>;
		};
		const runs = raw?.runs;
		if (!runs) {return false;}
		const parentKeyPattern = `:web:${parentWebSessionId}`;
		const now = Date.now();
		for (const entry of Object.values(runs)) {
			const requester = typeof entry.requesterSessionKey === "string" ? entry.requesterSessionKey : "";
			if (!requester.endsWith(parentKeyPattern)) {continue;}
			if (typeof entry.endedAt === "number") {continue;}
			const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : 0;
			if (createdAt > 0 && now - createdAt > SUBAGENT_REGISTRY_STALENESS_MS) {continue;}
			return true;
		}
	} catch { /* ignore */ }
	return false;
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
	// Always replay buffered events for errored runs so error messages
	// are never silently dropped due to replay:false timing.
	if (run.status !== "running" && run.status !== "waiting-for-subagents") {
		if (!replay && run.status === "error") {
			for (const event of run.eventBuffer) {
				callback(event);
			}
		}
		callback(null);
		return () => {};
	}

	run.subscribers.add(callback);
	return () => {
		run.subscribers.delete(callback);
	};
}

/**
 * Reactivate a completed subscribe-only run for a follow-up message.
 * Resets status to "running" and restarts the subscribe stream.
 */
export function reactivateSubscribeRun(sessionKey: string, message?: string): boolean {
	const run = activeRuns.get(sessionKey);
	if (!run?.isSubscribeOnly) {return false;}
	if (run.status === "running") {return true;}

	run.status = "running";
	run._lifecycleEnded = false;
	if (run._finalizeTimer) {clearTimeout(run._finalizeTimer); run._finalizeTimer = null;}
	clearWaitingFinalizeTimer(run);
	resetSubscribeRetryState(run);
	stopSubscribeProcess(run);

	run.accumulated = {
		id: `assistant-${sessionKey}-${Date.now()}`,
		role: "assistant",
		parts: [],
	};

	// When a follow-up message is provided, use start mode so the `agent`
	// RPC streams ALL events (including tool events) on the same connection.
	// In passive subscribe mode, tool events are not broadcast by the gateway.
	const newChild = message
		? spawnAgentStartForSession(message, sessionKey)
		: spawnAgentSubscribeProcess(sessionKey, run.lastGlobalSeq);
	run._subscribeProcess = newChild;
	run.childProcess = newChild;
	wireSubscribeOnlyProcess(run, newChild, sessionKey);
	return true;
}

/**
 * Send a follow-up message to a subagent session via gateway RPC.
 * The subscribe stream picks up the agent's response events.
 */
export function sendSubagentFollowUp(sessionKey: string, message: string): boolean {
	try {
		void callGatewayRpc(
			"agent",
			{
				message,
				sessionKey,
				idempotencyKey: `follow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				deliver: false,
				channel: "webchat",
				lane: "subagent",
				timeout: 0,
			},
			{ timeoutMs: 10_000 },
		).catch(() => {
			// Best effort.
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Persist a user message for a subscribe-only (subagent) run.
 * Emits a user-message event so reconnecting clients see the message,
 * and writes the message to the session JSONL file on disk.
 */
export async function persistSubscribeUserMessage(
	sessionKey: string,
	msg: { id?: string; text: string },
): Promise<boolean> {
	const run = activeRuns.get(sessionKey);
	if (!run) {return false;}
	const msgId = msg.id ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const event: SseEvent = {
		type: "user-message",
		id: msgId,
		text: msg.text,
	};
	run.eventBuffer.push(event);
	for (const sub of run.subscribers) {
		try { sub(event); } catch { /* ignore */ }
	}

	// Write the user message to the session JSONL (same as persistUserMessage
	// does for parent sessions) so it survives page reloads.
	try {
		const fp = safeSessionFilePath(sessionKey);
		await ensureDir();
		await queueFileMutation(fp, async () => {
			if (!await pathExistsAsync(fp)) {await writeFile(fp, "");}
			const content = await readFile(fp, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());
			const alreadySaved = lines.some((l) => {
				try { return JSON.parse(l).id === msgId; } catch { return false; }
			});
			if (alreadySaved) {
				return;
			}
			const line = JSON.stringify({
				id: msgId,
				role: "user",
				content: msg.text,
				parts: [{ type: "text", text: msg.text }],
				timestamp: new Date().toISOString(),
			});
			await writeFile(fp, [...lines, line].join("\n") + "\n");
		});
	} catch { /* best effort */ }

	schedulePersist(run);
	return true;
}

/** Abort a running agent. Returns true if a run was actually aborted. */
export function abortRun(sessionId: string): boolean {
	const run = activeRuns.get(sessionId);
	if (!run || (run.status !== "running" && run.status !== "waiting-for-subagents")) {return false;}

	// Immediately mark the run as non-running so hasActiveRun() returns
	// false and the next user message isn't rejected with 409.
	const wasWaiting = run.status === "waiting-for-subagents";
	run.status = "error";
	clearWaitingFinalizeTimer(run);

	// Clean up waiting subscribe process if present.
	stopSubscribeProcess(run);

	run.abortController.abort();
	if (!wasWaiting) {
		run.childProcess.kill("SIGTERM");
	}

	// Send chat.abort to the gateway.  Now that runs are started via
	// chat.send (not the agent RPC), they are registered in the gateway's
	// session-level tracking and chat.abort can find them from any connection.
	sendGatewayAbort(sessionId);

	// Flush persistence to save the partial response (without _streaming).
	flushPersistence(run).catch(() => {});

	// Signal subscribers that the stream ended.
	for (const sub of run.subscribers) {
		try { sub(null); } catch { /* ignore */ }
	}
	run.subscribers.clear();

	// Schedule grace-period cleanup (guard: only if we're still the active run).
	setTimeout(() => {
		if (activeRuns.get(sessionId) === run) {
			cleanupRun(sessionId);
		}
	}, CLEANUP_GRACE_MS);

	// Fallback: if the child doesn't exit within 5 seconds after
	// SIGTERM (e.g. the CLI's best-effort chat.abort RPC hangs),
	// send SIGKILL to force-terminate.
	if (!wasWaiting) {
		const killTimer = setTimeout(() => {
			try {
				run.childProcess.kill("SIGKILL");
			} catch { /* already dead */ }
		}, 5_000);
		run.childProcess.once("close", () => clearTimeout(killTimer));
	}

	return true;
}

/**
 * Send a `chat.abort` RPC directly to the gateway daemon via a short-lived
 * CLI process.  This is a belt-and-suspenders complement to the SIGTERM sent
 * to the child: even if the child's best-effort `onAbort` callback doesn't
 * reach the gateway in time, this separate process will.
 */
function sendGatewayAbort(sessionId: string): void {
	try {
		const run = activeRuns.get(sessionId);
		const agentId = run?.pinnedAgentId ?? resolveActiveAgentId();
		const sessionKey = run?.pinnedSessionKey ?? `agent:${agentId}:web:${sessionId}`;
		void callGatewayRpc("chat.abort", { sessionKey }, { timeoutMs: 4_000 }).catch(
			() => {
				// Best effort; don't let abort failures break the stop flow.
			},
		);
	} catch {
		// Best-effort; don't let abort failures break the stop flow.
	}
}

/**
 * Start a new agent run for the given session.
 * Throws if a run is already active for this session.
 */
export function startRun(params: {
	sessionId: string;
	message: string;
	agentSessionId?: string;
	/** Use a specific agent ID instead of the workspace default. */
	overrideAgentId?: string;
	/** Image attachments to forward to the gateway for vision models. */
	attachments?: Array<{ mediaType: string; data: string }>;
}): ActiveRun {
	const { sessionId, message, agentSessionId, overrideAgentId, attachments } = params;

	const existing = activeRuns.get(sessionId);
	if (existing?.status === "running") {
		throw new Error("Active run already exists for this session");
	}
	// Clean up a finished run that's still in the grace period.
	if (existing) {cleanupRun(sessionId);}

	const agentId = overrideAgentId ?? resolveActiveAgentId();
	const sessionKey = agentSessionId
		? `agent:${agentId}:web:${agentSessionId}`
		: undefined;
	const abortController = new AbortController();
	const child = spawnAgentProcess(message, agentSessionId, overrideAgentId, attachments);

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
		lastGlobalSeq: 0,
		_subscribeRetryTimer: null,
		_subscribeRetryAttempt: 0,
		_waitingFinalizeTimer: null,
		pinnedAgentId: agentId,
		pinnedSessionKey: sessionKey,
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

/**
 * Start a subscribe-only run for a subagent session.
 * The agent is already running in the gateway; we just subscribe to its
 * event stream so buffering, persistence, and reconnection work identically
 * to parent sessions.
 */
export function startSubscribeRun(params: {
	sessionKey: string;
	parentSessionId: string;
	task: string;
	label?: string;
}): ActiveRun {
	const { sessionKey, parentSessionId, task, label } = params;

	if (activeRuns.has(sessionKey)) {
		return activeRuns.get(sessionKey)!;
	}

	// Patch verbose level BEFORE spawning the subscribe process so tool
	// events are generated for events that occur after this point.
	// The subscribe process also patches, but this gives us a head start.
	void callGatewayRpc(
		"sessions.patch",
		{
			key: sessionKey,
			thinkingLevel: "high",
			verboseLevel: "full",
			reasoningLevel: "on",
		},
		{ timeoutMs: 4_000 },
	).catch(() => {});

	const abortController = new AbortController();
	const subscribeChild = spawnAgentSubscribeProcess(sessionKey, 0);

	const run: ActiveRun = {
		sessionId: sessionKey,
		childProcess: subscribeChild,
		eventBuffer: [],
		subscribers: new Set(),
		accumulated: {
			id: `assistant-${sessionKey}-${Date.now()}`,
			role: "assistant",
			parts: [],
		},
		status: "running",
		startedAt: Date.now(),
		exitCode: null,
		abortController,
		_persistTimer: null,
		_lastPersistedAt: 0,
		lastGlobalSeq: 0,
		sessionKey,
		parentSessionId,
		task,
		label,
		isSubscribeOnly: true,
		_lifecycleEnded: false,
		_finalizeTimer: null,
		_subscribeRetryTimer: null,
		_subscribeRetryAttempt: 0,
		_waitingFinalizeTimer: null,
	};

	activeRuns.set(sessionKey, run);
	wireSubscribeOnlyProcess(run, subscribeChild, sessionKey);
	return run;
}

type TranscriptToolPart = {
	type: "tool-invocation";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: Record<string, unknown>;
};

function readLatestTranscriptToolParts(
	sessionKey: string,
	pinnedAgentId?: string,
): { sessionId: string; tools: TranscriptToolPart[] } | null {
	const stateDir = resolveOpenClawStateDir();
	const agentId = pinnedAgentId ?? resolveActiveAgentId();
	const sessionsJsonPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");
	if (!existsSync(sessionsJsonPath)) { return null; }
	const sessions = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as Record<string, Record<string, unknown>>;
	const sessionData = sessions[sessionKey];
	const sessionId = typeof sessionData?.sessionId === "string" ? sessionData.sessionId : null;
	if (!sessionId) { return null; }
	const transcriptPath = join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
	if (!existsSync(transcriptPath)) { return null; }

	const entries = readFileSync(transcriptPath, "utf-8")
		.split("\n").filter((l) => l.trim())
		.map((l) => { try { return JSON.parse(l); } catch { return null; } })
		.filter(Boolean) as Array<Record<string, unknown>>;

	const toolResults = new Map<string, Record<string, unknown>>();
	let latestToolCalls: TranscriptToolPart[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") { continue; }
		const msg = entry.message as Record<string, unknown> | undefined;
		if (!msg) { continue; }
		const role = typeof msg.role === "string" ? msg.role : "";
		const content = msg.content;

		if (role === "toolResult" && typeof msg.toolCallId === "string") {
			const text = Array.isArray(content)
				? (content as Array<Record<string, unknown>>)
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text as string).join("\n")
				: typeof content === "string" ? content : "";
			toolResults.set(msg.toolCallId, { text: text.slice(0, 500) });
			continue;
		}

		if (role !== "assistant" || !Array.isArray(content)) { continue; }
		const calls: TranscriptToolPart[] = [];
		for (const part of content as Array<Record<string, unknown>>) {
			if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
				calls.push({
					type: "tool-invocation",
					toolCallId: part.id,
					toolName: part.name,
					args: (part.arguments as Record<string, unknown>) ?? {},
				});
			}
		}
		if (calls.length > 0) {
			latestToolCalls = calls;
		}
	}

	if (latestToolCalls.length === 0) {
		return null;
	}

	const withResults = latestToolCalls.map((tool) => {
		const result = toolResults.get(tool.toolCallId);
		return result ? { ...tool, result } : tool;
	});

	return { sessionId, tools: withResults };
}

/**
 * Wire event processing for a subscribe-only run (subagent).
 * Uses the same processParentEvent pipeline as parent runs,
 * with deferred finalization on lifecycle/end.
 */
function wireSubscribeOnlyProcess(
	run: ActiveRun,
	child: AgentProcessHandle,
	sessionKey: string,
): void {
	let idCounter = 0;
	const nextId = (prefix: string) =>
		`${prefix}-${Date.now()}-${++idCounter}`;

	let currentTextId = "";
	let currentReasoningId = "";
	let currentStatusReasoningLabel: string | null = null;
	let textStarted = false;
	let reasoningStarted = false;
	let statusReasoningActive = false;
	let agentErrorReported = false;
	const liveStats = {
		assistantChunks: 0,
		toolStartCount: 0,
	};

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

	const emit = (event: SseEvent) => {
		run.eventBuffer.push(event);
		for (const sub of run.subscribers) {
			try { sub(event); } catch { /* ignore */ }
		}
		schedulePersist(run);
	};

	const emitError = (message: string) => {
		closeReasoning();
		closeText();
		const tid = nextId("text");
		emit({ type: "text-start", id: tid });
		emit({ type: "text-delta", id: tid, delta: `[error] ${message}` });
		emit({ type: "text-end", id: tid });
		accAppendText(`[error] ${message}`);
	};

	const closeReasoning = () => {
		if (reasoningStarted) {
			emit({ type: "reasoning-end", id: currentReasoningId });
			reasoningStarted = false;
			statusReasoningActive = false;
		}
		currentStatusReasoningLabel = null;
		accReasoningIdx = -1;
	};

	const closeText = () => {
		if (textStarted) {
			const lastPart = run.accumulated.parts[accTextIdx];
			if (lastPart?.type === "text" && isLeakedSilentReplyToken(lastPart.text)) {
				run.accumulated.parts.splice(accTextIdx, 1);
			}
			emit({ type: "text-end", id: currentTextId });
			textStarted = false;
		}
		accTextIdx = -1;
	};

	const openStatusReasoning = (label: string) => {
		if (statusReasoningActive && currentStatusReasoningLabel === label) {
			return;
		}
		closeReasoning();
		closeText();
		currentReasoningId = nextId("status");
		emit({ type: "reasoning-start", id: currentReasoningId });
		emit({ type: "reasoning-delta", id: currentReasoningId, delta: label });
		reasoningStarted = true;
		statusReasoningActive = true;
		currentStatusReasoningLabel = label;
	};

	const maybeBackfillLiveToolsFromTranscript = (_reason: "assistant-chunk" | "lifecycle-end") => {
		if (liveStats.toolStartCount > 0) {
			return;
		}
		const bundle = readLatestTranscriptToolParts(sessionKey, run.pinnedAgentId);
		if (!bundle) {
			return;
		}

		for (const tool of bundle.tools) {
			const existingIdx = accToolMap.get(tool.toolCallId);
			if (existingIdx === undefined) {
				closeReasoning();
				closeText();
				emit({
					type: "tool-input-start",
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
				});
				emit({
					type: "tool-input-available",
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					input: tool.args ?? {},
				});
				run.accumulated.parts.push({
					type: "tool-invocation",
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					args: tool.args ?? {},
				});
				accToolMap.set(tool.toolCallId, run.accumulated.parts.length - 1);
			}

			if (!tool.result) {
				continue;
			}

			const idx = accToolMap.get(tool.toolCallId);
			if (idx === undefined) {
				continue;
			}
			const part = run.accumulated.parts[idx];
			if (part.type !== "tool-invocation" || part.result) {
				continue;
			}
			part.result = tool.result;
			emit({
				type: "tool-output-available",
				toolCallId: tool.toolCallId,
				output: tool.result,
			});
		}
	};

	const processEvent = (ev: AgentEvent) => {
		const isLifecycleEndEvent =
			ev.event === "agent" &&
			ev.stream === "lifecycle" &&
			ev.data?.phase === "end";
		if (!isLifecycleEndEvent) {
			if (run._finalizeTimer) {
				clearTimeout(run._finalizeTimer);
				run._finalizeTimer = null;
			}
			run._lifecycleEnded = false;
		}

		if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "start") {
			openStatusReasoning("Preparing response...");
		}

		if (ev.event === "agent" && ev.stream === "thinking") {
			const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
			if (delta) {
				if (statusReasoningActive) { closeReasoning(); }
				if (!reasoningStarted) {
					currentReasoningId = nextId("reasoning");
					emit({ type: "reasoning-start", id: currentReasoningId });
					reasoningStarted = true;
				}
				emit({ type: "reasoning-delta", id: currentReasoningId, delta });
				accAppendReasoning(delta);
			}
		}

		if (ev.event === "agent" && ev.stream === "assistant") {
			const delta = typeof ev.data?.delta === "string" ? ev.data.delta : undefined;
			const textFallback = !delta && typeof ev.data?.text === "string" ? ev.data.text : undefined;
			const chunk = delta ?? textFallback;
			if (chunk) {
				liveStats.assistantChunks += 1;
				if (
					liveStats.toolStartCount === 0 &&
					(liveStats.assistantChunks === 1 || liveStats.assistantChunks % 40 === 0)
				) {
					maybeBackfillLiveToolsFromTranscript("assistant-chunk");
				}
				closeReasoning();
				if (!textStarted) {
					currentTextId = nextId("text");
					emit({ type: "text-start", id: currentTextId });
					textStarted = true;
				}
				emit({ type: "text-delta", id: currentTextId, delta: chunk });
				accAppendText(chunk);
			}
			const mediaUrls = ev.data?.mediaUrls;
			if (Array.isArray(mediaUrls)) {
				for (const url of mediaUrls) {
					if (typeof url === "string" && url.trim()) {
						closeReasoning();
						if (!textStarted) {
							currentTextId = nextId("text");
							emit({ type: "text-start", id: currentTextId });
							textStarted = true;
						}
						const md = `\n![media](${url.trim()})\n`;
						emit({ type: "text-delta", id: currentTextId, delta: md });
						accAppendText(md);
					}
				}
			}
		if (typeof ev.data?.stopReason === "string" && ev.data.stopReason === "error" && !agentErrorReported) {
			agentErrorReported = true;
			const errMsg = typeof ev.data?.errorMessage === "string"
				? parseErrorBody(ev.data.errorMessage)
				: (parseAgentErrorMessage(ev.data) ?? "Agent stopped with an error");
			emitError(errMsg);
		}
	}

	if (ev.event === "agent" && ev.stream === "tool") {
		const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
		const toolCallId = typeof ev.data?.toolCallId === "string" ? ev.data.toolCallId : "";
		const toolName = typeof ev.data?.name === "string" ? ev.data.name : "";
			if (phase === "start") {
				liveStats.toolStartCount += 1;
				closeReasoning();
				closeText();
				const args = ev.data?.args && typeof ev.data.args === "object" ? (ev.data.args as Record<string, unknown>) : {};
				emit({ type: "tool-input-start", toolCallId, toolName });
				emit({ type: "tool-input-available", toolCallId, toolName, input: args });
				run.accumulated.parts.push({ type: "tool-invocation", toolCallId, toolName, args });
				accToolMap.set(toolCallId, run.accumulated.parts.length - 1);
			} else if (phase === "update") {
				const partialResult = extractToolResult(ev.data?.partialResult);
				if (partialResult) {
					const output = buildToolOutput(partialResult);
					emit({ type: "tool-output-partial", toolCallId, output });
				}
			} else if (phase === "result") {
				const isError = ev.data?.isError === true;
				const result = extractToolResult(ev.data?.result);
				if (isError) {
					const errorText = result?.text || (result?.details?.error as string | undefined) || "Tool execution failed";
					emit({ type: "tool-output-error", toolCallId, errorText });
					const idx = accToolMap.get(toolCallId);
					if (idx !== undefined) {
						const part = run.accumulated.parts[idx];
						if (part.type === "tool-invocation") {
							part.errorText = errorText;
						}
					}
				} else {
					const output = buildToolOutput(result);
					emit({ type: "tool-output-available", toolCallId, output });
					const idx = accToolMap.get(toolCallId);
					if (idx !== undefined) {
						const part = run.accumulated.parts[idx];
						if (part.type === "tool-invocation") { part.result = output; }
					}
				}
			}
		}

		if (ev.event === "agent" && ev.stream === "lifecycle" && (ev.data?.phase === "fallback" || ev.data?.phase === "fallback_cleared")) {
			const data = ev.data;
			const selected = resolveModelLabel(data?.selectedProvider, data?.selectedModel)
				?? resolveModelLabel(data?.fromProvider, data?.fromModel);
			const active = resolveModelLabel(data?.activeProvider, data?.activeModel)
				?? resolveModelLabel(data?.toProvider, data?.toModel);
			if (selected && active) {
				const isClear = data?.phase === "fallback_cleared";
				const reason = typeof data?.reasonSummary === "string" ? data.reasonSummary
					: typeof data?.reason === "string" ? data.reason : undefined;
				const label = isClear
					? `Restored to ${selected}`
					: `Switched to ${active}${reason ? ` (${reason})` : ""}`;
				openStatusReasoning(label);
			}
		}

		if (ev.event === "agent" && ev.stream === "compaction") {
			const phase = typeof ev.data?.phase === "string" ? ev.data.phase : undefined;
			if (phase === "start") { openStatusReasoning("Optimizing session context..."); }
			else if (phase === "end") {
				if (statusReasoningActive) {
					if (ev.data?.willRetry === true) {
						const retryDelta = "\nRetrying with compacted context...";
						emit({ type: "reasoning-delta", id: currentReasoningId, delta: retryDelta });
						accAppendReasoning(retryDelta);
					} else { closeReasoning(); }
				}
			}
		}

		if (ev.event === "chat") {
			const finalText = extractAssistantTextFromChatPayload(ev.data);
			if (finalText) {
				closeReasoning();
				if (!textStarted) {
					currentTextId = nextId("text");
					emit({ type: "text-start", id: currentTextId });
					textStarted = true;
				}
				emit({ type: "text-delta", id: currentTextId, delta: finalText });
				accAppendText(finalText);
				closeText();
			}
		}

		if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "end") {
			maybeBackfillLiveToolsFromTranscript("lifecycle-end");
			closeReasoning();
			closeText();
			run._lifecycleEnded = true;
			if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); }
			run._finalizeTimer = setTimeout(() => {
				run._finalizeTimer = null;
				if (run.status === "running") { finalizeSubscribeRun(run); }
			}, SUBSCRIBE_LIFECYCLE_END_GRACE_MS);
		}

	if (ev.event === "agent" && ev.stream === "lifecycle" && ev.data?.phase === "error" && !agentErrorReported) {
		agentErrorReported = true;
		emitError(parseAgentErrorMessage(ev.data) ?? "Agent encountered an error");
		finalizeSubscribeRun(run, "error");
	}

	if (ev.event === "error" && !agentErrorReported) {
		agentErrorReported = true;
		emitError(parseAgentErrorMessage(ev.data ?? (ev as unknown as Record<string, unknown>)) ?? "An unknown error occurred");
	}
};

const rl = createInterface({ input: child.stdout! });

	rl.on("line", (line: string) => {
		if (!line.trim()) { return; }
		let ev: AgentEvent;
		try { ev = JSON.parse(line) as AgentEvent; } catch { return; }
		if (ev.sessionKey && ev.sessionKey !== sessionKey) { return; }
		const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number"
			? (ev as Record<string, unknown>).globalSeq as number
			: undefined;
		if (gSeq !== undefined) {
			if (gSeq <= run.lastGlobalSeq) { return; }
			run.lastGlobalSeq = gSeq;
		}
		if ((run._subscribeRetryAttempt ?? 0) > 0) {
			resetSubscribeRetryState(run);
		}
		processEvent(ev);
	});

	child.on("close", () => {
		if (run._subscribeProcess !== child) {
			return;
		}
		run._subscribeProcess = null;
		if (run.status !== "running") { return; }
		if (run._lifecycleEnded) {
			if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
			finalizeSubscribeRun(run);
			return;
		}
		scheduleSubscribeRestart(run, () => {
			if (run.status === "running" && !run._subscribeProcess) {
				const newChild = spawnAgentSubscribeProcess(sessionKey, run.lastGlobalSeq);
				run._subscribeProcess = newChild;
				run.childProcess = newChild;
				wireSubscribeOnlyProcess(run, newChild, sessionKey);
			}
		});
	});

	child.on("error", (err) => {
		console.error("[active-runs] Subscribe child error:", err);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[active-runs subscribe stderr]", chunk.toString());
	});

	run._subscribeProcess = child;
}

function finalizeSubscribeRun(run: ActiveRun, status: "completed" | "error" = "completed"): void {
	if (run.status !== "running") { return; }
	if (run._finalizeTimer) { clearTimeout(run._finalizeTimer); run._finalizeTimer = null; }
	clearWaitingFinalizeTimer(run);
	resetSubscribeRetryState(run);

	run.status = status;
	flushPersistence(run).catch(() => {});

	for (const sub of run.subscribers) {
		try { sub(null); } catch { /* ignore */ }
	}
	run.subscribers.clear();

	stopSubscribeProcess(run);

	const hasToolParts = run.accumulated.parts.some((p) => p.type === "tool-invocation");

	// Deferred enrichment: after the gateway writes the transcript (2s delay),
	// backfill tool-invocation parts from the transcript into the web-chat JSONL.
	if (run.isSubscribeOnly && run.sessionKey && !hasToolParts) {
		const sessionKey = run.sessionKey;
		const agentId = run.pinnedAgentId;
		setTimeout(() => { deferredTranscriptEnrich(sessionKey, agentId); }, 2_000);
	}

	const grace = run.isSubscribeOnly ? SUBSCRIBE_CLEANUP_GRACE_MS : CLEANUP_GRACE_MS;
	setTimeout(() => {
		if (activeRuns.get(run.sessionId) === run) { cleanupRun(run.sessionId); }
	}, grace);
}

/**
 * Deferred enrichment: reads the gateway's session transcript and backfills
 * tool-invocation parts into the web-chat JSONL for a subagent session.
 * Matches tools to assistant messages by text content to avoid index-mapping issues.
 */
function deferredTranscriptEnrich(sessionKey: string, pinnedAgentId?: string): void {
	try {
		const stateDir = resolveOpenClawStateDir();
		const agentId = pinnedAgentId ?? resolveActiveAgentId();
		const sessionsJsonPath = join(stateDir, "agents", agentId, "sessions", "sessions.json");
		if (!existsSync(sessionsJsonPath)) {return;}

		const sessions = JSON.parse(readFileSync(sessionsJsonPath, "utf-8")) as Record<string, Record<string, unknown>>;
		const sessionData = sessions[sessionKey];
		const sessionId = typeof sessionData?.sessionId === "string" ? sessionData.sessionId : null;
		if (!sessionId) {return;}

		const transcriptPath = join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
		if (!existsSync(transcriptPath)) {return;}

		// Build text→tools map from transcript
		const entries = readFileSync(transcriptPath, "utf-8")
			.split("\n").filter((l) => l.trim())
			.map((l) => { try { return JSON.parse(l); } catch { return null; } })
			.filter(Boolean) as Array<Record<string, unknown>>;

		const toolResults = new Map<string, Record<string, unknown>>();
		let pendingTools: Array<Record<string, unknown>> = [];
		const textToTools = new Map<string, Array<Record<string, unknown>>>();

		for (const entry of entries) {
			if (entry.type !== "message") {continue;}
			const msg = entry.message as Record<string, unknown> | undefined;
			if (!msg) {continue;}
			const content = msg.content;
			if (msg.role === "user") { pendingTools = []; }
			if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				const text = Array.isArray(content)
					? (content as Array<Record<string, unknown>>)
						.filter((c) => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text as string).join("\n")
					: typeof content === "string" ? content : "";
				toolResults.set(msg.toolCallId, { text: text.slice(0, 500) });
			}
			if (msg.role !== "assistant" || !Array.isArray(content)) {continue;}
			for (const part of content as Array<Record<string, unknown>>) {
				if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
					pendingTools.push({
						type: "tool-invocation", toolCallId: part.id,
						toolName: part.name, args: (part.arguments as Record<string, unknown>) ?? {},
					});
				}
			}
			const textParts = (content as Array<Record<string, unknown>>)
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => (c.text as string).trim()).filter(Boolean);
			if (textParts.length > 0 && pendingTools.length > 0) {
				const key = textParts.join("\n").slice(0, 200);
				if (key.length >= 10) {
					const toolsWithResults = pendingTools.map((tp) => {
						const result = toolResults.get(tp.toolCallId as string);
						return result ? { ...tp, result } : tp;
					});
					textToTools.set(key, toolsWithResults);
					pendingTools = [];
				}
			}
		}

		if (textToTools.size === 0) {return;}

		// Read and enrich web-chat JSONL
		const fp = safeSessionFilePath(sessionKey);
		if (!existsSync(fp)) {return;}
		const lines = readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim());
		const messages = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;

		let changed = false;
		const enriched = messages.map((m) => {
			if (m.role !== "assistant") {return m;}
			const parts = (m.parts as Array<Record<string, unknown>>) ?? [{ type: "text", text: m.content }];
			if (parts.some((p) => p.type === "tool-invocation")) {return m;}
			const msgText = parts
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => (p.text as string).trim()).filter(Boolean)
				.join("\n").slice(0, 200);
			if (msgText.length < 10) {return m;}
			const tools = textToTools.get(msgText);
			if (!tools || tools.length === 0) {return m;}
			const textP = parts.filter((p) => p.type === "text");
			const otherP = parts.filter((p) => p.type !== "text");
			changed = true;
			return { ...m, parts: [...otherP, ...tools, ...textP] };
		});

		if (changed) {
			writeFileSync(fp, enriched.map((m) => JSON.stringify(m)).join("\n") + "\n");
		}
	} catch { /* best effort */ }
}

/**
 * Opportunistic on-read backfill for subagent sessions.
 * This is safe to call repeatedly; enrichment is idempotent.
 */
export function enrichSubagentSessionFromTranscript(sessionKey: string): void {
	if (!sessionKey.includes(":subagent:")) {
		return;
	}
	deferredTranscriptEnrich(sessionKey);
}

// ── Persistence helpers (called from route to persist user messages) ──

/** Save a user message to the session JSONL (called once at run start). */
export async function persistUserMessage(
	sessionId: string,
	msg: { id: string; content: string; parts?: unknown[]; html?: string },
): Promise<void> {
	await ensureDir();
	const filePath = safeSessionFilePath(sessionId);

	const line = JSON.stringify({
		id: msg.id,
		role: "user",
		content: msg.content,
		...(msg.parts ? { parts: msg.parts } : {}),
		...(msg.html ? { html: msg.html } : {}),
		timestamp: new Date().toISOString(),
	});

	let alreadySaved = false;
	await queueFileMutation(filePath, async () => {
		if (!await pathExistsAsync(filePath)) {await writeFile(filePath, "");}

		// Avoid duplicates (e.g. retry).
		const existing = await readFile(filePath, "utf-8");
		const lines = existing.split("\n").filter((l) => l.trim());
		alreadySaved = lines.some((l) => {
			try {
				return JSON.parse(l).id === msg.id;
			} catch {
				return false;
			}
		});

		if (!alreadySaved) {
			await writeFile(filePath, [...lines, line].join("\n") + "\n");
		}
	});

	if (!alreadySaved) {
		await updateIndex(sessionId, { incrementCount: 1 });
	}
}

// ── Internals ──

async function ensureDir() {
	await mkdir(webChatDir(), { recursive: true });
}

async function updateIndex(
	sessionId: string,
	opts: { incrementCount?: number; title?: string },
) {
	try {
		const idxPath = indexFile();
		await ensureDir();
		await queueFileMutation(idxPath, async () => {
			let index: Array<Record<string, unknown>>;
			if (!await pathExistsAsync(idxPath)) {
				// Auto-create index with a bootstrap entry for this session so
				// orphaned .jsonl files become visible in the sidebar.
				index = [{
					id: sessionId,
					title: opts.title || "New Chat",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messageCount: opts.incrementCount || 0,
				}];
				await writeFile(idxPath, JSON.stringify(index, null, 2));
				return;
			}
			index = JSON.parse(
				await readFile(idxPath, "utf-8"),
			) as Array<Record<string, unknown>>;
			let session = index.find((s) => s.id === sessionId);
			if (!session) {
				// Session file exists but wasn't indexed — add it.
				session = {
					id: sessionId,
					title: opts.title || "New Chat",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					messageCount: 0,
				};
				index.unshift(session);
			}
			session.updatedAt = Date.now();
			if (opts.incrementCount) {
				session.messageCount =
					((session.messageCount as number) || 0) + opts.incrementCount;
			}
			if (opts.title) {session.title = opts.title;}
			await writeFile(idxPath, JSON.stringify(index, null, 2));
		});
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
	let currentStatusReasoningLabel: string | null = null;
	let textStarted = false;
	let reasoningStarted = false;
	let everSentText = false;
	let statusReasoningActive = false;
	let waitingStatusAnnounced = false;
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
		currentStatusReasoningLabel = null;
		accReasoningIdx = -1;
	};

	const closeText = () => {
		if (textStarted) {
			if (accTextIdx >= 0) {
				const part = run.accumulated.parts[accTextIdx] as { type: "text"; text: string };
				if (isLeakedSilentReplyToken(part.text)) {
					run.accumulated.parts.splice(accTextIdx, 1);
					for (const [k, v] of accToolMap) {
						if (v > accTextIdx) { accToolMap.set(k, v - 1); }
					}
				}
			}
			emit({ type: "text-end", id: currentTextId });
			textStarted = false;
		}
		accTextIdx = -1;
	};

	const openStatusReasoning = (label: string) => {
		if (statusReasoningActive && currentStatusReasoningLabel === label) {
			return;
		}
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
		currentStatusReasoningLabel = label;
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

	const emitAssistantFinalText = (text: string) => {
		if (!text) {
			return;
		}
		closeReasoning();
		if (!textStarted) {
			currentTextId = nextId("text");
			emit({ type: "text-start", id: currentTextId });
			textStarted = true;
		}
		everSentText = true;
		emit({ type: "text-delta", id: currentTextId, delta: text });
		accAppendText(text);
		closeText();
	};

	// ── Parse stdout JSON lines ──

	const rl = createInterface({ input: child.stdout! });
	const pinnedAgent = run.pinnedAgentId ?? resolveActiveAgentId();
	const parentSessionKey = run.pinnedSessionKey ?? `agent:${pinnedAgent}:web:${run.sessionId}`;
	// Prevent unhandled 'error' events on the readline interface.
	// When the child process fails to start (e.g. ENOENT — missing script)
	// the stdout pipe is destroyed and readline re-emits the error.  Without
	// this handler Node.js throws "Unhandled 'error' event" which crashes
	// the API route instead of surfacing a clean message to the user.
	rl.on("error", () => {
		// Swallow — the child 'error' / 'close' handlers take care of
		// emitting user-visible diagnostics.
	});

	// ── Reusable parent event processor ──
	// Handles lifecycle, thinking, assistant text, tool, compaction, and error
	// events for the parent agent. Used by both the CLI NDJSON stream and the
	// subscribe-only CLI fallback (waiting-for-subagents state).

	const processParentEvent = (ev: AgentEvent) => {
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
			const textFallback =
				!delta && typeof ev.data?.text === "string"
					? ev.data.text
					: undefined;
			const chunk = delta ?? textFallback;
			if (chunk) {
				closeReasoning();
				if (!textStarted) {
					currentTextId = nextId("text");
					emit({ type: "text-start", id: currentTextId });
					textStarted = true;
				}
				everSentText = true;
				emit({ type: "text-delta", id: currentTextId, delta: chunk });
				accAppendText(chunk);
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
			!agentErrorReported
		) {
			agentErrorReported = true;
			const errMsg = typeof ev.data?.errorMessage === "string"
				? parseErrorBody(ev.data.errorMessage)
				: (parseAgentErrorMessage(ev.data) ?? "Agent stopped with an error");
			emitError(errMsg);
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
				run.accumulated.parts.push({
					type: "tool-invocation",
					toolCallId,
					toolName,
					args,
				});
				accToolMap.set(toolCallId, run.accumulated.parts.length - 1);
			} else if (phase === "update") {
				const partialResult = extractToolResult(ev.data?.partialResult);
				if (partialResult) {
					const output = buildToolOutput(partialResult);
					emit({ type: "tool-output-partial", toolCallId, output });
				}
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
					const idx = accToolMap.get(toolCallId);
					if (idx !== undefined) {
						const part = run.accumulated.parts[idx];
						if (part.type === "tool-invocation") {
							part.result = output;
						}
					}
				}

				if (toolName === "sessions_spawn" && !isError) {
					const childSessionKey =
						result?.details?.childSessionKey as string | undefined;
					if (childSessionKey) {
						const spawnArgs = accToolMap.has(toolCallId)
							? (run.accumulated.parts[accToolMap.get(toolCallId)!] as { args?: Record<string, unknown> })?.args
							: undefined;
						startSubscribeRun({
							sessionKey: childSessionKey,
							parentSessionId: run.sessionId,
							task: (spawnArgs?.task as string | undefined) ?? "Subagent task",
							label: spawnArgs?.label as string | undefined,
						});
					}
				}
			}
		}

		// Model fallback events
		if (
			ev.event === "agent" &&
			ev.stream === "lifecycle" &&
			(ev.data?.phase === "fallback" || ev.data?.phase === "fallback_cleared")
		) {
			const data = ev.data;
			const selected = resolveModelLabel(data?.selectedProvider, data?.selectedModel)
				?? resolveModelLabel(data?.fromProvider, data?.fromModel);
			const active = resolveModelLabel(data?.activeProvider, data?.activeModel)
				?? resolveModelLabel(data?.toProvider, data?.toModel);
			if (selected && active) {
				const isClear = data?.phase === "fallback_cleared";
				const reason = typeof data?.reasonSummary === "string" ? data.reasonSummary
					: typeof data?.reason === "string" ? data.reason : undefined;
				const label = isClear
					? `Restored to ${selected}`
					: `Switched to ${active}${reason ? ` (${reason})` : ""}`;
				openStatusReasoning(label);
			}
		}

		// Chat final events can include assistant turns from runs outside
		// the original parent process (e.g. subagent announce follow-ups).
		if (ev.event === "chat") {
			const text = extractAssistantTextFromChatPayload(ev.data);
			if (text) {
				emitAssistantFinalText(text);
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
		agentErrorReported = true;
		emitError(parseAgentErrorMessage(ev.data) ?? "Agent encountered an error");
	}

	// Top-level error event
	if (ev.event === "error" && !agentErrorReported) {
		agentErrorReported = true;
		emitError(
			parseAgentErrorMessage(
				ev.data ??
					(ev as unknown as Record<string, unknown>),
			) ?? "An unknown error occurred",
		);
	}
};

	const processParentSubscribeEvent = (ev: AgentEvent) => {
		const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number"
			? (ev as Record<string, unknown>).globalSeq as number
			: undefined;
		if (gSeq !== undefined) {
			if (gSeq <= run.lastGlobalSeq) {return;}
			run.lastGlobalSeq = gSeq;
		}

		const showWaitingStatus = () => {
			if (!waitingStatusAnnounced) {
				openStatusReasoning("Waiting for subagent results...");
				waitingStatusAnnounced = true;
			}
			flushPersistence(run).catch(() => {});
		};

		const scheduleWaitingCompletionCheck = () => {
			clearWaitingFinalizeTimer(run);
			run._waitingFinalizeTimer = setTimeout(async () => {
				run._waitingFinalizeTimer = null;
				if (run.status !== "waiting-for-subagents") {
					return;
				}
				if (await hasRunningSubagentsForParent(run.sessionId)) {
					showWaitingStatus();
					return;
				}
				finalizeWaitingRun(run);
			}, WAITING_FINALIZE_RECONCILE_MS);
		};

		const reconcileWaitingState = () => {
			if (run.status !== "waiting-for-subagents" && run.status !== "running") {
				return;
			}
			if (hasRunningSubagentsInMemory(run.sessionId)) {
				clearWaitingFinalizeTimer(run);
				showWaitingStatus();
				return;
			}
			scheduleWaitingCompletionCheck();
		};

		// Any new parent event means waiting completion should be reconsidered
		// from this point forward, not from a prior end/final checkpoint.
		clearWaitingFinalizeTimer(run);

		processParentEvent(ev);
		if (ev.stream === "lifecycle" && ev.data?.phase === "end") {
			reconcileWaitingState();
		}
		if (ev.event === "chat") {
			const payload = ev.data;
			const state = typeof payload?.state === "string" ? payload.state : "";
			const message = asRecord(payload?.message);
			const role = typeof message?.role === "string" ? message.role : "";
			if (state === "final" && role === "assistant") {
				reconcileWaitingState();
			}
		}
	};

	rl.on("line", (line: string) => {
		if (!line.trim()) {return;}

		let ev: AgentEvent;
		try {
			ev = JSON.parse(line) as AgentEvent;
		} catch {
			return;
		}

		// Skip events from other sessions (e.g. subagent broadcasts that
		// the gateway delivers on the same WS connection).
		if (ev.sessionKey && ev.sessionKey !== parentSessionKey) {
			return;
		}

		// Track the global event cursor from the gateway for replay on handoff.
		const gSeq = typeof (ev as Record<string, unknown>).globalSeq === "number"
			? (ev as Record<string, unknown>).globalSeq as number
			: undefined;
		if (gSeq !== undefined && gSeq > run.lastGlobalSeq) {
			run.lastGlobalSeq = gSeq;
		}

		processParentEvent(ev);
	});

	// ── Child process exit ──

	child.on("close", (code) => {
		// If already finalized (e.g. by abortRun), just record the exit code.
		if (run.status !== "running") {
			run.exitCode = code;
			return;
		}

		if (!agentErrorReported && stderrChunks.length > 0) {
			const stderr = stderrChunks.join("").trim();
			const msg = parseErrorFromStderr(stderr);
			if (msg) {
				agentErrorReported = true;
				emitError(msg);
			}
		}

		closeReasoning();

		const exitedClean = code === 0 || code === null;

		if (!everSentText && !exitedClean) {
			const tid = nextId("text");
			emit({ type: "text-start", id: tid });
			const errMsg = `[error] Agent exited with code ${code}. Check server logs for details.`;
			emit({ type: "text-delta", id: tid, delta: errMsg });
			emit({ type: "text-end", id: tid });
			accAppendText(errMsg);
		} else if (!everSentText && exitedClean) {
			emitError("No response from agent.");
		} else {
			closeText();
		}

		run.exitCode = code;

		const hasRunningSubagents = hasRunningSubagentsInMemory(run.sessionId);

		// If the CLI exited cleanly and subagents are still running,
		// keep the SSE stream open and wait for announcement-triggered
		// parent turns via subscribe-only CLI NDJSON.
		if (exitedClean && hasRunningSubagents) {
			run.status = "waiting-for-subagents";

			if (!waitingStatusAnnounced) {
				openStatusReasoning("Waiting for subagent results...");
				waitingStatusAnnounced = true;
			}
			flushPersistence(run).catch(() => {});
			startParentSubscribeStream(run, parentSessionKey, processParentSubscribeEvent);

			// Safety: force-finalize if waiting exceeds the maximum duration
			setTimeout(() => {
				if (run.status === "waiting-for-subagents") {
					finalizeWaitingRun(run);
				}
			}, MAX_WAITING_DURATION_MS);
			return;
		}

		// Normal completion path.
		run.status = exitedClean ? "completed" : "error";

		// Final persistence flush (removes _streaming flag).
		flushPersistence(run).catch(() => {});

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
		// Guard: only clean up if we're still the active run for this session.
		setTimeout(() => {
			if (activeRuns.get(run.sessionId) === run) {
				cleanupRun(run.sessionId);
			}
		}, CLEANUP_GRACE_MS);
	});

	child.on("error", (err) => {
		// If already finalized (e.g. by abortRun), skip.
		if (run.status !== "running") {return;}

		console.error("[active-runs] Child process error:", err);
		const message = err instanceof Error ? err.message : String(err);
		emitError(`Failed to start agent: ${message}`);
		run.status = "error";
		flushPersistence(run).catch(() => {});
		for (const sub of run.subscribers) {
			try {
				sub(null);
			} catch {
				/* ignore */
			}
		}
		run.subscribers.clear();
		setTimeout(() => {
			if (activeRuns.get(run.sessionId) === run) {
				cleanupRun(run.sessionId);
			}
		}, CLEANUP_GRACE_MS);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		stderrChunks.push(text);
		console.error("[active-runs stderr]", text);
	});
}

function startParentSubscribeStream(
	run: ActiveRun,
	parentSessionKey: string,
	onEvent: (ev: AgentEvent) => void,
): void {
	stopSubscribeProcess(run);
	const child = spawnAgentSubscribeProcess(parentSessionKey, run.lastGlobalSeq);
	run._subscribeProcess = child;
	const rl = createInterface({ input: child.stdout! });

	rl.on("line", (line: string) => {
		if (!line.trim()) {return;}
		let ev: AgentEvent;
		try {
			ev = JSON.parse(line) as AgentEvent;
		} catch {
			return;
		}
		if (ev.sessionKey && ev.sessionKey !== parentSessionKey) {
			return;
		}
		if ((run._subscribeRetryAttempt ?? 0) > 0) {
			resetSubscribeRetryState(run);
		}
		onEvent(ev);
	});

	child.on("close", () => {
		if (run._subscribeProcess !== child) {
			return;
		}
		run._subscribeProcess = null;
		if (run.status !== "waiting-for-subagents") {return;}
		// If still waiting, restart subscribe stream from the latest cursor.
		scheduleSubscribeRestart(run, () => {
			if (run.status === "waiting-for-subagents" && !run._subscribeProcess) {
				startParentSubscribeStream(run, parentSessionKey, onEvent);
			}
		});
	});

	child.on("error", (err) => {
		console.error("[active-runs] Parent subscribe child error:", err);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		console.error("[active-runs subscribe stderr]", chunk.toString());
	});
}

function stopSubscribeProcess(run: ActiveRun): void {
	clearSubscribeRetryTimer(run);
	clearWaitingFinalizeTimer(run);
	if (!run._subscribeProcess) {return;}
	try {
		run._subscribeProcess.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	run._subscribeProcess = null;
}

// ── Finalize a waiting-for-subagents run ──

/**
 * Transition a run from "waiting-for-subagents" to "completed".
 * Called when the last subagent finishes and the parent's announcement-
 * triggered turn completes.
 */
function finalizeWaitingRun(run: ActiveRun): void {
	if (run.status !== "waiting-for-subagents") {return;}

	run.status = "completed";
	clearWaitingFinalizeTimer(run);
	resetSubscribeRetryState(run);

	stopSubscribeProcess(run);

	flushPersistence(run).catch(() => {});

	for (const sub of run.subscribers) {
		try { sub(null); } catch { /* ignore */ }
	}
	run.subscribers.clear();

	setTimeout(() => {
		if (activeRuns.get(run.sessionId) === run) {
			cleanupRun(run.sessionId);
		}
	}, CLEANUP_GRACE_MS);
}

function clearWaitingFinalizeTimer(run: ActiveRun): void {
	if (!run._waitingFinalizeTimer) {
		return;
	}
	clearTimeout(run._waitingFinalizeTimer);
	run._waitingFinalizeTimer = null;
}

function clearSubscribeRetryTimer(run: ActiveRun): void {
	if (!run._subscribeRetryTimer) {
		return;
	}
	clearTimeout(run._subscribeRetryTimer);
	run._subscribeRetryTimer = null;
}

function resetSubscribeRetryState(run: ActiveRun): void {
	run._subscribeRetryAttempt = 0;
	clearSubscribeRetryTimer(run);
}

function scheduleSubscribeRestart(run: ActiveRun, restart: () => void): void {
	if (run._subscribeRetryTimer) {
		return;
	}
	const attempt = run._subscribeRetryAttempt ?? 0;
	const delay = Math.min(
		SUBSCRIBE_RETRY_MAX_MS,
		SUBSCRIBE_RETRY_BASE_MS * 2 ** attempt,
	);
	run._subscribeRetryAttempt = attempt + 1;
	run._subscribeRetryTimer = setTimeout(() => {
		run._subscribeRetryTimer = null;
		restart();
	}, delay);
}

// ── Debounced persistence ──

function schedulePersist(run: ActiveRun) {
	if (run._persistTimer) {return;}
	const elapsed = Date.now() - run._lastPersistedAt;
	const delay = Math.max(0, PERSIST_INTERVAL_MS - elapsed);
	run._persistTimer = setTimeout(() => {
		run._persistTimer = null;
		flushPersistence(run).catch(() => {});
	}, delay);
}

async function flushPersistence(run: ActiveRun) {
	if (run._persistTimer) {
		clearTimeout(run._persistTimer);
		run._persistTimer = null;
	}
	run._lastPersistedAt = Date.now();

	const parts = run.accumulated.parts;
	if (parts.length === 0) {
		return; // Nothing to persist yet.
	}

	// Filter out leaked silent-reply text fragments before persisting.
	const cleanParts = parts.filter((p) =>
		p.type !== "text" || !isLeakedSilentReplyToken((p as { text: string }).text),
	);

	// Build content text from text parts for the backwards-compatible
	// content field (used when parts are not available).
	const text = cleanParts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");

	const isStillStreaming = run.status === "running" || run.status === "waiting-for-subagents";
	const message: Record<string, unknown> = {
		id: run.accumulated.id,
		role: "assistant",
		content: text,
		parts: cleanParts,
		timestamp: new Date().toISOString(),
	};
	if (isStillStreaming) {
		message._streaming = true;
	}

	try {
		await upsertMessage(run.sessionId, message);
	} catch (err) {
		console.error("[active-runs] Persistence error:", err);
	}
}

/**
 * Upsert a single message into the session JSONL.
 * If a line with the same `id` already exists it is replaced; otherwise appended.
 */
async function upsertMessage(
	sessionId: string,
	message: Record<string, unknown>,
) {
	await ensureDir();
	const fp = safeSessionFilePath(sessionId);
	const msgId = message.id as string;
	let found = false;
	await queueFileMutation(fp, async () => {
		if (!await pathExistsAsync(fp)) {await writeFile(fp, "");}
		const content = await readFile(fp, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim());
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
		}

		await writeFile(fp, updated.join("\n") + "\n");
	});

	if (!sessionId.includes(":subagent:")) {
		if (!found) {
			await updateIndex(sessionId, { incrementCount: 1 });
		} else {
			await updateIndex(sessionId, {});
		}
	}
}

function cleanupRun(sessionId: string) {
	const run = activeRuns.get(sessionId);
	if (!run) {return;}
	if (run._persistTimer) {clearTimeout(run._persistTimer);}
	clearWaitingFinalizeTimer(run);
	stopSubscribeProcess(run);
	activeRuns.delete(sessionId);
}
