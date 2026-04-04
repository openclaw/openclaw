import { type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock workspace to prevent disk I/O and provide stable agent IDs
vi.mock("./workspace", () => ({
	resolveWebChatDir: vi.fn(() => "/tmp/mock-web-chat"),
	resolveOpenClawStateDir: vi.fn(() => "/tmp/mock-state"),
	resolveActiveAgentId: vi.fn(() => "main"),
}));

vi.mock("./chat-agent-registry", () => ({
	markChatAgentIdle: vi.fn(),
}));

// Mock agent-runner to control spawnAgentProcess
vi.mock("./agent-runner", () => ({
	spawnAgentProcess: vi.fn(),
	spawnAgentSubscribeProcess: vi.fn(),
	callGatewayRpc: vi.fn(() => Promise.resolve({ ok: true })),
	extractToolResult: vi.fn((raw: unknown) => {
		if (!raw) {return undefined;}
		if (typeof raw === "string") {return { text: raw };}
		return { text: undefined, details: raw as Record<string, unknown> };
	}),
	buildToolOutput: vi.fn(
		(result?: { text?: string }) => (result ? { text: result.text } : {}),
	),
	parseAgentErrorMessage: vi.fn((data?: Record<string, unknown>) => {
		if (data?.error && typeof data.error === "string") {return data.error;}
		if (data?.message && typeof data.message === "string") {return data.message;}
		return undefined;
	}),
	parseErrorBody: vi.fn((raw: string) => raw),
	parseErrorFromStderr: vi.fn((stderr: string) => {
		if (!stderr) {return undefined;}
		if (/error/i.test(stderr)) {return stderr.trim();}
		return undefined;
	}),
}));

// Mock fs operations used for persistence so tests don't hit disk
vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => ""),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		access: vi.fn(async () => {
			throw new Error("ENOENT");
		}),
		readFile: vi.fn(async () => ""),
		writeFile: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
	};
});

import type { SseEvent } from "./active-runs.js";

/**
 * Create a mock child process with a real PassThrough stream for stdout,
 * so the readline interface inside wireChildProcess actually receives data.
 */
function createMockChild() {
	const events: Record<string, ((...args: unknown[]) => void)[]> = {};
	const stdoutStream = new PassThrough();
	const stderrStream = new PassThrough();

	const child = {
		exitCode: null as number | null,
		killed: false,
		pid: 12345,
		stdout: stdoutStream,
		stderr: stderrStream,
		on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			events[event] = events[event] || [];
			events[event].push(cb);
			return child;
		}),
		once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			events[event] = events[event] || [];
			events[event].push(cb);
			return child;
		}),
		kill: vi.fn(),
		/** Emit an event to all registered listeners. */
		_emit(event: string, ...args: unknown[]) {
			for (const cb of events[event] || []) {
				cb(...args);
			}
		},
		/** Write a JSON line to stdout (simulating agent output). */
		_writeLine(jsonObj: Record<string, unknown>) {
			stdoutStream.write(JSON.stringify(jsonObj) + "\n");
		},
		/** Write raw text to stderr. */
		_writeStderr(text: string) {
			stderrStream.write(Buffer.from(text));
		},
	};

	return child;
}

describe("active-runs", () => {
	beforeEach(() => {
		vi.resetModules();

		vi.mock("./workspace", () => ({
			resolveWebChatDir: vi.fn(() => "/tmp/mock-web-chat"),
			resolveOpenClawStateDir: vi.fn(() => "/tmp/mock-state"),
			resolveActiveAgentId: vi.fn(() => "main"),
		}));

		vi.mock("./chat-agent-registry", () => ({
			markChatAgentIdle: vi.fn(),
		}));

		// Re-wire mocks after resetModules
		vi.mock("./agent-runner", () => ({
			spawnAgentProcess: vi.fn(),
			spawnAgentSubscribeProcess: vi.fn(),
			callGatewayRpc: vi.fn(() => Promise.resolve({ ok: true })),
			extractToolResult: vi.fn((raw: unknown) => {
				if (!raw) {return undefined;}
				if (typeof raw === "string") {return { text: raw };}
				return {
					text: undefined,
					details: raw as Record<string, unknown>,
				};
			}),
			buildToolOutput: vi.fn(
				(result?: { text?: string }) =>
					result ? { text: result.text } : {},
			),
			parseAgentErrorMessage: vi.fn(
				(data?: Record<string, unknown>) => {
					if (data?.error && typeof data.error === "string")
						{return data.error;}
					if (data?.message && typeof data.message === "string")
						{return data.message;}
					return undefined;
				},
			),
			parseErrorBody: vi.fn((raw: string) => raw),
			parseErrorFromStderr: vi.fn((stderr: string) => {
				if (!stderr) {return undefined;}
				if (/error/i.test(stderr)) {return stderr.trim();}
				return undefined;
			}),
		}));

		vi.mock("node:fs", async (importOriginal) => {
			const original =
				await importOriginal<typeof import("node:fs")>();
			return {
				...original,
				existsSync: vi.fn(() => false),
				readFileSync: vi.fn(() => ""),
				writeFileSync: vi.fn(),
				mkdirSync: vi.fn(),
			};
		});
		vi.mock("node:fs/promises", async (importOriginal) => {
			const original =
				await importOriginal<typeof import("node:fs/promises")>();
			return {
				...original,
				access: vi.fn(async () => {
					throw new Error("ENOENT");
				}),
				readFile: vi.fn(async () => ""),
				writeFile: vi.fn(async () => undefined),
				mkdir: vi.fn(async () => undefined),
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Helper: set up a mock child and import the active-runs module fresh. */
	async function setup() {
		const child = createMockChild();

		const { spawnAgentProcess } = await import("./agent-runner.js");
		vi.mocked(spawnAgentProcess).mockReturnValue(
			child as unknown as ChildProcess,
		);

		const mod = await import("./active-runs.js");
		return { child, ...mod };
	}

	// ── startRun + subscribeToRun ──────────────────────────────────────

	describe("startRun + subscribeToRun", () => {
		it("passes the session model override to spawnAgentProcess", async () => {
			const { startRun } = await setup();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			startRun({
				sessionId: "s-model",
				message: "hello",
				agentSessionId: "s-model",
				modelOverride: "gpt-5.4",
			});

			expect(spawnAgentProcess).toHaveBeenCalledWith(
				"hello",
				"s-model",
				undefined,
				"gpt-5.4",
			);
		});

		it("creates a run and emits fallback text when process exits without output", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s1",
				message: "hello",
				agentSessionId: "s1",
			});

			subscribeToRun(
				"s1",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			// Close stdout before emitting close, so readline finishes
			child.stdout.end();
			// Small delay to let readline drain
			await new Promise((r) => setTimeout(r, 50));

			child._emit("close", 0);

			// Should have emitted fallback "[error] No response from agent."
			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						(e.delta).includes("No response"),
				),
			).toBe(true);
		});

		it("replays buffered events to a late subscriber when the run already completed", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			startRun({
				sessionId: "s-late",
				message: "hello",
				agentSessionId: "s-late",
			});

			child._writeLine({
				event: "agent",
				stream: "assistant",
				data: { delta: "Fast reply" },
			});
			await new Promise((r) => setTimeout(r, 50));

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);

			const events: SseEvent[] = [];
			subscribeToRun(
				"s-late",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false, replayTerminalBuffer: true },
			);

			expect(events.some((e) => e.type === "text-start")).toBe(true);
			expect(
				events.some(
					(e) => e.type === "text-delta" && e.delta === "Fast reply",
				),
			).toBe(true);
		});

		it("does not emit the generic no-response fallback after tool-visible activity", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-tool",
				message: "use a tool",
				agentSessionId: "s-tool",
			});

			subscribeToRun(
				"s-tool",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child._writeLine({
				event: "agent",
				stream: "tool",
				data: {
					phase: "start",
					toolCallId: "tool-1",
					name: "searchDocs",
					args: { query: "chat bug" },
				},
			});
			child._writeLine({
				event: "agent",
				stream: "tool",
				data: {
					phase: "result",
					toolCallId: "tool-1",
					name: "searchDocs",
					result: { text: "found it" },
				},
			});
			await new Promise((r) => setTimeout(r, 50));

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);

			expect(events.some((e) => e.type === "tool-input-start")).toBe(true);
			expect(events.some((e) => e.type === "tool-output-available")).toBe(true);
			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						e.delta.includes("No response"),
				),
			).toBe(false);
		});

		it("streams assistant text events for agent assistant output", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-text",
				message: "say hi",
				agentSessionId: "s-text",
			});

			subscribeToRun(
				"s-text",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			// Emit an assistant text delta via stdout JSON
			child._writeLine({
				event: "agent",
				stream: "assistant",
				data: { delta: "Hello world!" },
			});

			// Give readline a tick to process
			await new Promise((r) => setTimeout(r, 50));

			// Should have text-start + text-delta
			expect(events.some((e) => e.type === "text-start")).toBe(true);
			expect(
				events.some(
					(e) => e.type === "text-delta" && e.delta === "Hello world!",
				),
			).toBe(true);

			// Clean up
			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});

		it("streams reasoning events for thinking output", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-think",
				message: "think about it",
				agentSessionId: "s-think",
			});

			subscribeToRun(
				"s-think",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child._writeLine({
				event: "agent",
				stream: "thinking",
				data: { delta: "Let me think..." },
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(events.some((e) => e.type === "reasoning-start")).toBe(
				true,
			);
			expect(
				events.some(
					(e) =>
						e.type === "reasoning-delta" &&
						e.delta === "Let me think...",
				),
			).toBe(true);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});

		it("streams tool-input-start and tool-input-available for tool calls", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-tool",
				message: "use a tool",
				agentSessionId: "s-tool",
			});

			subscribeToRun(
				"s-tool",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child._writeLine({
				event: "agent",
				stream: "tool",
				data: {
					phase: "start",
					toolCallId: "tc-1",
					name: "search",
					args: { query: "test" },
				},
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(
				events.some(
					(e) =>
						e.type === "tool-input-start" &&
						e.toolCallId === "tc-1",
				),
			).toBe(true);
			expect(
				events.some(
					(e) =>
						e.type === "tool-input-available" &&
						e.toolCallId === "tc-1" &&
						e.toolName === "search",
				),
			).toBe(true);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});

		it("emits error text for non-zero exit code", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-fail",
				message: "fail",
				agentSessionId: "s-fail",
			});

			subscribeToRun(
				"s-fail",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 1);

			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						(e.delta).includes("exited with code 1"),
				),
			).toBe(true);
		});

		it("signals completion (null) to subscribers when run finishes", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const completed: boolean[] = [];

			startRun({
				sessionId: "s-complete",
				message: "hi",
				agentSessionId: "s-complete",
			});

			subscribeToRun(
				"s-complete",
				(event) => {
					if (event === null) {completed.push(true);}
				},
				{ replay: false },
			);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);

			expect(completed).toHaveLength(1);
		});
	});

	// ── child process error handling ────────────────────────────────────

	describe("child process error handling", () => {
		it("emits 'Failed to start agent' on spawn error (ENOENT)", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];
			const completions: boolean[] = [];

			startRun({
				sessionId: "s-enoent",
				message: "hello",
				agentSessionId: "s-enoent",
			});

			subscribeToRun(
				"s-enoent",
				(event) => {
					if (event) {
						events.push(event);
					} else {
						completions.push(true);
					}
				},
				{ replay: false },
			);

			const err = new Error("spawn node ENOENT");
			(err as NodeJS.ErrnoException).code = "ENOENT";
			child._emit("error", err);

			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						(e.delta).includes("Failed to start agent"),
				),
			).toBe(true);

			expect(completions).toHaveLength(1);
		});

		it("surfaces scope error with remediation steps when Gateway rejects operator.write", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];
			const completions: boolean[] = [];

			startRun({
				sessionId: "s-scope",
				message: "hello",
				agentSessionId: "s-scope",
			});

			subscribeToRun(
				"s-scope",
				(event) => {
					if (event) {
						events.push(event);
					} else {
						completions.push(true);
					}
				},
				{ replay: false },
			);

			const err = new Error("missing scope: operator.write. The OpenClaw Gateway rejected this request because the web app's credentials lack the required scope. Fix: run `npx denchclaw bootstrap` to re-pair, or set OPENCLAW_GATEWAY_PASSWORD in the web app's environment.");
			child._emit("error", err);

			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						(e.delta).includes("Failed to start agent") &&
						(e.delta).includes("missing scope: operator.write"),
				),
			).toBe(true);

			expect(completions).toHaveLength(1);
		});

		it("does not crash on readline error (the root cause of 'Unhandled error event')", async () => {
			const { child, startRun } = await setup();

			startRun({
				sessionId: "s-rl-err",
				message: "hello",
				agentSessionId: "s-rl-err",
			});

			// Simulate what happens when a child process fails to start:
			// stdout stream is destroyed with an error, which readline re-emits.
			// Before the fix, this would throw "Unhandled 'error' event".
			// After the fix, the rl.on("error") handler swallows it.
			expect(() => {
				child.stdout.destroy(new Error("stream destroyed"));
			}).not.toThrow();

			// Give a tick for the error to propagate
			await new Promise((r) => setTimeout(r, 50));

			// The run should still be tracked (error handler on child takes care of cleanup)
		});
	});

	// ── subscribeToRun replay ──────────────────────────────────────────

	describe("subscribeToRun replay", () => {
		it("replays buffered events to new subscribers", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			startRun({
				sessionId: "s-replay",
				message: "hi",
				agentSessionId: "s-replay",
			});

			// Generate some events
			child._writeLine({
				event: "agent",
				stream: "assistant",
				data: { delta: "Hello" },
			});

			await new Promise((r) => setTimeout(r, 50));

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);

			// New subscriber with replay=true
			const replayed: (SseEvent | null)[] = [];
			subscribeToRun(
				"s-replay",
				(event) => {
					replayed.push(event);
				},
				{ replay: true },
			);

			// Should include the text events + null (completion)
			expect(replayed.length).toBeGreaterThan(0);
			expect(replayed[replayed.length - 1]).toBeNull();
			expect(
				replayed.some(
					(e) =>
						e !== null &&
						e.type === "text-delta" &&
						e.delta === "Hello",
				),
			).toBe(true);
		});

		it("returns null for unsubscribe when no run exists", async () => {
			const { subscribeToRun } = await setup();

			const unsub = subscribeToRun(
				"nonexistent",
				() => {},
				{ replay: true },
			);

			expect(unsub).toBeNull();
		});
	});

	// ── hasActiveRun / getActiveRun ────────────────────────────────────

	describe("hasActiveRun / getActiveRun", () => {
		it("returns true for a running process", async () => {
			const { child: _child, startRun, hasActiveRun, getActiveRun } =
				await setup();

			startRun({
				sessionId: "s-active",
				message: "hi",
				agentSessionId: "s-active",
			});

			expect(hasActiveRun("s-active")).toBe(true);
			expect(getActiveRun("s-active")).toBeDefined();
			expect(getActiveRun("s-active")?.status).toBe("running");
		});

		it("marks status as completed after clean exit", async () => {
			const { child, startRun, hasActiveRun, getActiveRun } =
				await setup();

			startRun({
				sessionId: "s-done",
				message: "hi",
				agentSessionId: "s-done",
			});

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);

			expect(hasActiveRun("s-done")).toBe(false);
			expect(getActiveRun("s-done")?.status).toBe("completed");
		});

		it("marks status as error after non-zero exit", async () => {
			const { child, startRun, getActiveRun } = await setup();

			startRun({
				sessionId: "s-err-exit",
				message: "hi",
				agentSessionId: "s-err-exit",
			});

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 1);

			expect(getActiveRun("s-err-exit")?.status).toBe("error");
		});

		it("returns false for unknown sessions", async () => {
			const { hasActiveRun, getActiveRun } = await setup();
			expect(hasActiveRun("nonexistent")).toBe(false);
			expect(getActiveRun("nonexistent")).toBeUndefined();
		});
	});

	// ── abortRun ──────────────────────────────────────────────────────

	describe("abortRun", () => {
		it("kills a running child process", async () => {
			const { child, startRun, abortRun } = await setup();
			const { callGatewayRpc } = await import("./agent-runner.js");

			startRun({
				sessionId: "s-abort",
				message: "hi",
				agentSessionId: "s-abort",
			});

			expect(abortRun("s-abort")).toBe(true);
			expect(child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(vi.mocked(callGatewayRpc)).toHaveBeenCalledWith(
				"chat.abort",
				{ sessionKey: "agent:main:web:s-abort" },
				{ timeoutMs: 4_000 },
			);
		});

		it("returns false for non-running sessions", async () => {
			const { abortRun } = await setup();
			expect(abortRun("nonexistent")).toBe(false);
		});

		it("immediately marks the run as non-active so new messages are not blocked", async () => {
			const { startRun, abortRun, hasActiveRun, getActiveRun } = await setup();

			startRun({
				sessionId: "s-abort-status",
				message: "hi",
				agentSessionId: "s-abort-status",
			});

			expect(hasActiveRun("s-abort-status")).toBe(true);

			abortRun("s-abort-status");

			// hasActiveRun must return false immediately after abort
			// (before the child process exits), otherwise the next
			// user message is rejected with 409.
			expect(hasActiveRun("s-abort-status")).toBe(false);
			expect(getActiveRun("s-abort-status")?.status).toBe("error");
		});

		it("allows starting a new run after abort (no 409 race)", async () => {
			const { startRun, abortRun, hasActiveRun } = await setup();

			startRun({
				sessionId: "s-abort-new",
				message: "first",
				agentSessionId: "s-abort-new",
			});

			abortRun("s-abort-new");

			// Starting a new run for the same session should succeed.
			expect(() =>
				startRun({
					sessionId: "s-abort-new",
					message: "second",
					agentSessionId: "s-abort-new",
				}),
			).not.toThrow();

			expect(hasActiveRun("s-abort-new")).toBe(true);
		});

		it("signals subscribers with null on abort", async () => {
			const { startRun, abortRun, subscribeToRun } = await setup();

			const completed: boolean[] = [];

			startRun({
				sessionId: "s-abort-sub",
				message: "hi",
				agentSessionId: "s-abort-sub",
			});

			subscribeToRun(
				"s-abort-sub",
				(event) => {
					if (event === null) {completed.push(true);}
				},
				{ replay: false },
			);

			abortRun("s-abort-sub");

			expect(completed).toHaveLength(1);
		});

		it("aborts runs while waiting for subagents", async () => {
			const { startRun, startSubscribeRun, abortRun, getActiveRun } = await setup();
			const { spawnAgentProcess, spawnAgentSubscribeProcess } = await import(
				"./agent-runner.js"
			);
			const mockRunSpawn = vi.mocked(spawnAgentProcess);
			const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
			mockRunSpawn.mockReset();
			mockSubscribeSpawn.mockReset();

			const parentChild = createMockChild();
			const subagentStream = createMockChild();
			const parentSubscribe = createMockChild();

			mockRunSpawn.mockReturnValue(parentChild as unknown as ChildProcess);
			mockSubscribeSpawn
				.mockReturnValueOnce(subagentStream as unknown as ChildProcess)
				.mockReturnValueOnce(parentSubscribe as unknown as ChildProcess);

			startSubscribeRun({
				sessionKey: "sub:waiting:abort",
				parentSessionId: "parent-waiting-abort",
				task: "child task",
			});
			startRun({
				sessionId: "parent-waiting-abort",
				message: "run parent",
				agentSessionId: "parent-waiting-abort",
			});

			parentChild.stdout.end();
			await new Promise((r) => setTimeout(r, 0));
			parentChild._emit("close", 0);

			expect(getActiveRun("parent-waiting-abort")?.status).toBe(
				"waiting-for-subagents",
			);
			expect(abortRun("parent-waiting-abort")).toBe(true);
			expect(parentSubscribe.kill).toHaveBeenCalledWith("SIGTERM");
			expect(getActiveRun("parent-waiting-abort")?.status).toBe("error");
		});
	});

	describe("sendSubagentFollowUp", () => {
		it("sends follow-up over gateway RPC", async () => {
			const { sendSubagentFollowUp } = await setup();
			const { callGatewayRpc } = await import("./agent-runner.js");

			expect(sendSubagentFollowUp("session-1", "continue")).toBe(true);
			expect(vi.mocked(callGatewayRpc)).toHaveBeenCalledWith(
				"agent",
				expect.objectContaining({
					sessionKey: "session-1",
					message: "continue",
					channel: "webchat",
					lane: "subagent",
					deliver: false,
					timeout: 0,
				}),
				{ timeoutMs: 10_000 },
			);
		});
	});

	describe("subscribe stream restart stability", () => {
		it("uses bounded exponential backoff for subscribe-only restarts and resets after first event", async () => {
			vi.useFakeTimers();
			try {
				const { startSubscribeRun, abortRun } = await setup();
				const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");
				const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
				mockSubscribeSpawn.mockReset();

				const first = createMockChild();
				const second = createMockChild();
				const third = createMockChild();
				const fourth = createMockChild();
				mockSubscribeSpawn
					.mockReturnValueOnce(first as unknown as ChildProcess)
					.mockReturnValueOnce(second as unknown as ChildProcess)
					.mockReturnValueOnce(third as unknown as ChildProcess)
					.mockReturnValueOnce(fourth as unknown as ChildProcess);

				startSubscribeRun({
					sessionKey: "sub:retry:one",
					parentSessionId: "parent-retry",
					task: "retry task",
				});
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(1);

				first._emit("close", 1);
				await vi.advanceTimersByTimeAsync(299);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(2);

				second._emit("close", 1);
				await vi.advanceTimersByTimeAsync(599);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(3);

				third._writeLine({
					event: "agent",
					sessionKey: "sub:retry:one",
					stream: "assistant",
					data: { delta: "recovered" },
					globalSeq: 1,
				});
				await vi.advanceTimersByTimeAsync(0);

				third._emit("close", 1);
				await vi.advanceTimersByTimeAsync(299);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(3);
				await vi.advanceTimersByTimeAsync(1);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(4);

				expect(abortRun("sub:retry:one")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("retries parent waiting streams with backoff instead of tight loops", async () => {
			vi.useFakeTimers();
			try {
				const { startRun, startSubscribeRun, getActiveRun, abortRun } =
					await setup();
				const { spawnAgentProcess, spawnAgentSubscribeProcess } = await import(
					"./agent-runner.js"
				);
				const mockRunSpawn = vi.mocked(spawnAgentProcess);
				const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
				mockRunSpawn.mockReset();
				mockSubscribeSpawn.mockReset();

				const parentChild = createMockChild();
				const subagentStream = createMockChild();
				const parentSubscribeFirst = createMockChild();
				const parentSubscribeSecond = createMockChild();

				mockRunSpawn.mockReturnValue(parentChild as unknown as ChildProcess);
				mockSubscribeSpawn
					.mockReturnValueOnce(subagentStream as unknown as ChildProcess)
					.mockReturnValueOnce(parentSubscribeFirst as unknown as ChildProcess)
					.mockReturnValueOnce(parentSubscribeSecond as unknown as ChildProcess);

				startSubscribeRun({
					sessionKey: "sub:parent:retry",
					parentSessionId: "parent-retry-2",
					task: "child task",
				});
				startRun({
					sessionId: "parent-retry-2",
					message: "run parent",
					agentSessionId: "parent-retry-2",
				});

				parentChild.stdout.end();
				await vi.advanceTimersByTimeAsync(0);
				parentChild._emit("close", 0);

				expect(getActiveRun("parent-retry-2")?.status).toBe(
					"waiting-for-subagents",
				);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(2);

				parentSubscribeFirst._emit("close", 1);
				await vi.advanceTimersByTimeAsync(299);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(3);

				expect(abortRun("parent-retry-2")).toBe(true);
				expect(abortRun("sub:parent:retry")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("streams multiple announce turns while waiting and finalizes after idle reconciliation", async () => {
			vi.useFakeTimers();
			try {
				const { startRun, startSubscribeRun, subscribeToRun, getActiveRun } =
					await setup();
				const { spawnAgentProcess, spawnAgentSubscribeProcess } = await import(
					"./agent-runner.js"
				);
				const mockRunSpawn = vi.mocked(spawnAgentProcess);
				const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
				mockRunSpawn.mockReset();
				mockSubscribeSpawn.mockReset();

				const parentChild = createMockChild();
				const subagentStream = createMockChild();
				const parentSubscribe = createMockChild();

				mockRunSpawn.mockReturnValue(parentChild as unknown as ChildProcess);
				mockSubscribeSpawn
					.mockReturnValueOnce(subagentStream as unknown as ChildProcess)
					.mockReturnValueOnce(parentSubscribe as unknown as ChildProcess);

				startSubscribeRun({
					sessionKey: "sub:announce:one",
					parentSessionId: "parent-announce",
					task: "child task",
				});
				startRun({
					sessionId: "parent-announce",
					message: "run parent",
					agentSessionId: "parent-announce",
				});

				const events: SseEvent[] = [];
				const completed: boolean[] = [];
				subscribeToRun(
					"parent-announce",
					(event) => {
						if (event) {
							events.push(event);
						} else {
							completed.push(true);
						}
					},
					{ replay: false },
				);

				parentChild.stdout.end();
				await vi.advanceTimersByTimeAsync(0);
				parentChild._emit("close", 0);
				expect(getActiveRun("parent-announce")?.status).toBe(
					"waiting-for-subagents",
				);

				subagentStream._writeLine({
					event: "agent",
					sessionKey: "sub:announce:one",
					stream: "lifecycle",
					data: { phase: "end" },
					globalSeq: 1,
				});
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(750);
				expect(getActiveRun("sub:announce:one")?.status).toBe("completed");

				parentSubscribe._writeLine({
					event: "chat",
					sessionKey: "agent:main:web:parent-announce",
					globalSeq: 2,
					data: {
						state: "final",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Subagent finished and reported back." }],
						},
					},
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(
					events.some(
						(e) =>
							e.type === "text-delta" &&
							typeof e.delta === "string" &&
							e.delta.includes("Subagent finished and reported back."),
					),
				).toBe(true);

				// A subsequent announce turn should keep the waiting run alive
				// by resetting the finalize reconciliation timer.
				parentSubscribe._writeLine({
					event: "agent",
					sessionKey: "agent:main:web:parent-announce",
					stream: "lifecycle",
					data: { phase: "start" },
					globalSeq: 3,
				});
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(4_900);
				expect(completed).toHaveLength(0);
				expect(getActiveRun("parent-announce")?.status).toBe(
					"waiting-for-subagents",
				);

				parentSubscribe._writeLine({
					event: "chat",
					sessionKey: "agent:main:web:parent-announce",
					globalSeq: 4,
					data: {
						state: "final",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Another subagent result delivered." }],
						},
					},
				});
				await vi.advanceTimersByTimeAsync(0);
				expect(
					events.some(
						(e) =>
							e.type === "text-delta" &&
							typeof e.delta === "string" &&
							e.delta.includes("Another subagent result delivered."),
					),
				).toBe(true);

				await vi.advanceTimersByTimeAsync(5_000);
				expect(completed).toHaveLength(1);
				expect(getActiveRun("parent-announce")?.status).toBe("completed");
			} finally {
				vi.useRealTimers();
			}
		});

		it("reconciles yielded parent waits when a child only finishes in the shared registry", async () => {
			vi.useFakeTimers();
			try {
				const { startRun, startSubscribeRun, subscribeToRun, getActiveRun } =
					await setup();
				const { spawnAgentProcess, spawnAgentSubscribeProcess } = await import(
					"./agent-runner.js"
				);
				const { existsSync, readFileSync } = await import("node:fs");
				const mockRunSpawn = vi.mocked(spawnAgentProcess);
				const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
				const mockExistsSync = vi.mocked(existsSync);
				const mockReadFileSync = vi.mocked(readFileSync);
				mockRunSpawn.mockReset();
				mockSubscribeSpawn.mockReset();
				mockExistsSync.mockReset();
				mockReadFileSync.mockReset();

				const parentChild = createMockChild();
				const subagentStream = createMockChild();
				const parentSubscribe = createMockChild();
				const unexpectedRestart = createMockChild();

				mockRunSpawn.mockReturnValue(parentChild as unknown as ChildProcess);
				mockSubscribeSpawn
					.mockReturnValueOnce(subagentStream as unknown as ChildProcess)
					.mockReturnValueOnce(parentSubscribe as unknown as ChildProcess)
					.mockReturnValue(unexpectedRestart as unknown as ChildProcess);

				let registryEnded = false;
				mockExistsSync.mockImplementation(((
					filePath: Parameters<typeof existsSync>[0],
				) => String(filePath).endsWith("/subagents/runs.json")) as typeof existsSync);
				mockReadFileSync.mockImplementation(((
					filePath: unknown,
				) => {
					if (String(filePath).endsWith("/subagents/runs.json")) {
						return JSON.stringify({
							runs: {
								stale: {
									requesterSessionKey: "agent:main:web:parent-yield-stale",
									childSessionKey: "sub:announce:stale",
									createdAt: Date.now(),
									...(registryEnded
										? {
											endedAt: Date.now(),
											outcome: { status: "completed" },
										}
										: {}),
								},
							},
						});
					}
					return "";
				}) as unknown as typeof readFileSync);

				startSubscribeRun({
					sessionKey: "sub:announce:stale",
					parentSessionId: "parent-yield-stale",
					task: "child task",
				});
				startRun({
					sessionId: "parent-yield-stale",
					message: "run parent",
					agentSessionId: "parent-yield-stale",
				});

				const events: SseEvent[] = [];
				const completed: boolean[] = [];
				subscribeToRun(
					"parent-yield-stale",
					(event) => {
						if (event) {
							events.push(event);
						} else {
							completed.push(true);
						}
					},
					{ replay: false },
				);

				parentChild.stdout.end();
				await vi.advanceTimersByTimeAsync(0);
				parentChild._emit("close", 0);

				expect(getActiveRun("parent-yield-stale")?.status).toBe(
					"waiting-for-subagents",
				);
				expect(getActiveRun("sub:announce:stale")?.status).toBe("running");

				registryEnded = true;
				subagentStream.stdout.end();
				await vi.advanceTimersByTimeAsync(0);
				subagentStream._emit("close", 0);

				expect(getActiveRun("sub:announce:stale")?.status).toBe("completed");
				expect(mockSubscribeSpawn).toHaveBeenCalledTimes(2);

				parentSubscribe._writeLine({
					event: "chat",
					sessionKey: "agent:main:web:parent-yield-stale",
					globalSeq: 2,
					data: {
						state: "final",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Both subagents are done." }],
						},
					},
				});
				await vi.advanceTimersByTimeAsync(0);

				expect(
					events.some(
						(e) =>
							e.type === "text-delta" &&
							typeof e.delta === "string" &&
							e.delta.includes("Both subagents are done."),
					),
				).toBe(true);

				await vi.advanceTimersByTimeAsync(5_000);
				expect(completed).toHaveLength(1);
				expect(getActiveRun("parent-yield-stale")?.status).toBe("completed");
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not spam duplicate waiting-status deltas while already waiting", async () => {
			vi.useFakeTimers();
			try {
				const { startRun, startSubscribeRun, subscribeToRun, abortRun } =
					await setup();
				const { spawnAgentProcess, spawnAgentSubscribeProcess } = await import(
					"./agent-runner.js"
				);
				const mockRunSpawn = vi.mocked(spawnAgentProcess);
				const mockSubscribeSpawn = vi.mocked(spawnAgentSubscribeProcess);
				mockRunSpawn.mockReset();
				mockSubscribeSpawn.mockReset();

				const parentChild = createMockChild();
				const subagentStream = createMockChild();
				const parentSubscribe = createMockChild();

				mockRunSpawn.mockReturnValue(parentChild as unknown as ChildProcess);
				mockSubscribeSpawn
					.mockReturnValueOnce(subagentStream as unknown as ChildProcess)
					.mockReturnValueOnce(parentSubscribe as unknown as ChildProcess);

				startSubscribeRun({
					sessionKey: "sub:waiting:dedupe",
					parentSessionId: "parent-waiting-dedupe",
					task: "child task",
				});
				startRun({
					sessionId: "parent-waiting-dedupe",
					message: "run parent",
					agentSessionId: "parent-waiting-dedupe",
				});

				const events: SseEvent[] = [];
				subscribeToRun(
					"parent-waiting-dedupe",
					(event) => {
						if (event) {
							events.push(event);
						}
					},
					{ replay: false },
				);

				parentChild.stdout.end();
				await vi.advanceTimersByTimeAsync(0);
				parentChild._emit("close", 0);
				await vi.advanceTimersByTimeAsync(0);

				const waitingText = "Waiting for subagent results...";
				const waitingCountAfterEnter = events.filter(
					(e) => e.type === "reasoning-delta" && e.delta === waitingText,
				).length;
				expect(waitingCountAfterEnter).toBe(1);

				parentSubscribe._writeLine({
					event: "agent",
					sessionKey: "agent:main:web:parent-waiting-dedupe",
					stream: "lifecycle",
					data: { phase: "end" },
					globalSeq: 2,
				});
				parentSubscribe._writeLine({
					event: "agent",
					sessionKey: "agent:main:web:parent-waiting-dedupe",
					stream: "lifecycle",
					data: { phase: "end" },
					globalSeq: 3,
				});
				await vi.advanceTimersByTimeAsync(0);

				const waitingCountFinal = events.filter(
					(e) => e.type === "reasoning-delta" && e.delta === waitingText,
				).length;
				expect(waitingCountFinal).toBe(1);

				expect(abortRun("parent-waiting-dedupe")).toBe(true);
				expect(abortRun("sub:waiting:dedupe")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// ── duplicate run prevention ──────────────────────────────────────

	describe("duplicate run prevention", () => {
		it("throws when starting a run for an already-active session", async () => {
			const { startRun } = await setup();

			startRun({
				sessionId: "s-dup",
				message: "first",
				agentSessionId: "s-dup",
			});

			expect(() =>
				startRun({
					sessionId: "s-dup",
					message: "second",
					agentSessionId: "s-dup",
				}),
			).toThrow("Active run already exists");
		});
	});

	// ── multiple concurrent runs ─────────────────────────────────────

	describe("multiple concurrent runs", () => {
		let concurrentCounter = 0;

		async function setupConcurrent() {
			concurrentCounter += 1;
			const prefix = `conc-${concurrentCounter}`;
			const childA = createMockChild();
			const childB = createMockChild();

			const { spawnAgentProcess } = await import("./agent-runner.js");
			vi.mocked(spawnAgentProcess)
				.mockReturnValueOnce(childA as unknown as ChildProcess)
				.mockReturnValueOnce(childB as unknown as ChildProcess);

			const mod = await import("./active-runs.js");
			return { childA, childB, prefix, ...mod };
		}

		it("tracks multiple sessions independently", async () => {
			const { childA, childB, prefix, startRun, abortRun, hasActiveRun, getActiveRun } =
				await setupConcurrent();

			const idA = `${prefix}-track-a`;
			const idB = `${prefix}-track-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			expect(hasActiveRun(idA)).toBe(true);
			expect(hasActiveRun(idB)).toBe(true);
			expect(getActiveRun(idA)?.status).toBe("running");
			expect(getActiveRun(idB)?.status).toBe("running");

			abortRun(idA);
			abortRun(idB);
		});

		it("delivers events to the correct session without cross-contamination", async () => {
			const { childA, childB, prefix, startRun, abortRun, subscribeToRun } =
				await setupConcurrent();

			const idA = `${prefix}-iso-a`;
			const idB = `${prefix}-iso-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			const eventsA: SseEvent[] = [];
			const eventsB: SseEvent[] = [];
			subscribeToRun(idA, (e) => { if (e) eventsA.push(e); }, { replay: false });
			subscribeToRun(idB, (e) => { if (e) eventsB.push(e); }, { replay: false });

			childA._writeLine({
				event: "agent", stream: "assistant",
				data: { delta: "Hello from A" },
			});
			childB._writeLine({
				event: "agent", stream: "assistant",
				data: { delta: "Hello from B" },
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(eventsA.some((e) => e.type === "text-delta" && e.delta === "Hello from A")).toBe(true);
			expect(eventsA.some((e) => e.type === "text-delta" && e.delta === "Hello from B")).toBe(false);

			expect(eventsB.some((e) => e.type === "text-delta" && e.delta === "Hello from B")).toBe(true);
			expect(eventsB.some((e) => e.type === "text-delta" && e.delta === "Hello from A")).toBe(false);

			childA.stdout.end();
			childB.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childA._emit("close", 0);
			childB._emit("close", 0);
		});

		it("completing one session does not affect the other", async () => {
			const { childA, childB, prefix, startRun, abortRun, hasActiveRun, getActiveRun } =
				await setupConcurrent();

			const idA = `${prefix}-comp-a`;
			const idB = `${prefix}-comp-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			childA.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childA._emit("close", 0);

			expect(hasActiveRun(idA)).toBe(false);
			expect(getActiveRun(idA)?.status).toBe("completed");

			expect(hasActiveRun(idB)).toBe(true);
			expect(getActiveRun(idB)?.status).toBe("running");

			childB.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childB._emit("close", 0);
		});

		it("aborting one session does not affect the other", async () => {
			const { prefix, startRun, abortRun, hasActiveRun, getActiveRun } =
				await setupConcurrent();

			const idA = `${prefix}-abt-a`;
			const idB = `${prefix}-abt-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			abortRun(idA);

			expect(hasActiveRun(idA)).toBe(false);
			expect(getActiveRun(idA)?.status).toBe("error");

			expect(hasActiveRun(idB)).toBe(true);
			expect(getActiveRun(idB)?.status).toBe("running");

			abortRun(idB);
		});

		it("session B can still receive events after session A completes", async () => {
			const { childA, childB, prefix, startRun, subscribeToRun, hasActiveRun } =
				await setupConcurrent();

			const idA = `${prefix}-cont-a`;
			const idB = `${prefix}-cont-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			const eventsB: SseEvent[] = [];
			subscribeToRun(idB, (e) => { if (e) eventsB.push(e); }, { replay: false });

			childA.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childA._emit("close", 0);
			expect(hasActiveRun(idA)).toBe(false);

			childB._writeLine({
				event: "agent", stream: "assistant",
				data: { delta: "Still running on B" },
			});
			await new Promise((r) => setTimeout(r, 50));

			expect(eventsB.some(
				(e) => e.type === "text-delta" && e.delta === "Still running on B",
			)).toBe(true);

			childB.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childB._emit("close", 0);
		});

		it("both sessions can stream tools concurrently", async () => {
			const { childA, childB, prefix, startRun, subscribeToRun } =
				await setupConcurrent();

			const idA = `${prefix}-tool-a`;
			const idB = `${prefix}-tool-b`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			const eventsA: SseEvent[] = [];
			const eventsB: SseEvent[] = [];
			subscribeToRun(idA, (e) => { if (e) eventsA.push(e); }, { replay: false });
			subscribeToRun(idB, (e) => { if (e) eventsB.push(e); }, { replay: false });

			childA._writeLine({
				event: "agent", stream: "tool",
				data: { phase: "start", toolCallId: "tc-a-1", name: "search", args: { q: "query A" } },
			});
			childB._writeLine({
				event: "agent", stream: "tool",
				data: { phase: "start", toolCallId: "tc-b-1", name: "browser", args: { url: "example.com" } },
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(eventsA.some(
				(e) => e.type === "tool-input-start" && e.toolCallId === "tc-a-1",
			)).toBe(true);
			expect(eventsA.some(
				(e) => e.type === "tool-input-start" && e.toolCallId === "tc-b-1",
			)).toBe(false);

			expect(eventsB.some(
				(e) => e.type === "tool-input-start" && e.toolCallId === "tc-b-1",
			)).toBe(true);
			expect(eventsB.some(
				(e) => e.type === "tool-input-start" && e.toolCallId === "tc-a-1",
			)).toBe(false);

			childA.stdout.end();
			childB.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			childA._emit("close", 0);
			childB._emit("close", 0);
		});

		it("duplicate run is rejected per-session, not globally", async () => {
			const { prefix, startRun, abortRun, hasActiveRun } =
				await setupConcurrent();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const idA = `${prefix}-dup-a`;
			const idB = `${prefix}-dup-b`;
			const idC = `${prefix}-dup-c`;

			startRun({ sessionId: idA, message: "first", agentSessionId: idA });
			startRun({ sessionId: idB, message: "second", agentSessionId: idB });

			expect(hasActiveRun(idA)).toBe(true);
			expect(hasActiveRun(idB)).toBe(true);

			const childC = createMockChild();
			vi.mocked(spawnAgentProcess).mockReturnValueOnce(
				childC as unknown as ChildProcess,
			);
			expect(() =>
				startRun({ sessionId: idC, message: "third", agentSessionId: idC }),
			).not.toThrow();
			expect(hasActiveRun(idC)).toBe(true);

			expect(() =>
				startRun({ sessionId: idA, message: "dupe", agentSessionId: idA }),
			).toThrow("Active run already exists");

			abortRun(idA);
			abortRun(idB);
			abortRun(idC);
		});
	});

	// ── tool result events ───────────────────────────────────────────

	describe("tool result events", () => {
		it("emits tool-result events for completed tool calls", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({ sessionId: "s-tr", message: "use tool", agentSessionId: "s-tr" });

			subscribeToRun("s-tr", (event) => {
				if (event) {events.push(event);}
			}, { replay: false });

			// Emit tool start
			child._writeLine({
				event: "agent",
				stream: "tool",
				data: { phase: "start", toolCallId: "tc-1", name: "search", args: { q: "test" } },
			});

			// Emit tool result
			child._writeLine({
				event: "agent",
				stream: "tool",
				data: { phase: "result", toolCallId: "tc-1", result: "found 3 results" },
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(events.some((e) => e.type === "tool-input-start" && e.toolCallId === "tc-1")).toBe(true);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});
	});

	// ── stderr handling ──────────────────────────────────────────────

	describe("stderr handling", () => {
		it("captures stderr output for error reporting", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({ sessionId: "s-stderr", message: "fail", agentSessionId: "s-stderr" });

			subscribeToRun("s-stderr", (event) => {
				if (event) {events.push(event);}
			}, { replay: false });

			child._writeStderr("Error: something went wrong\n");

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 1);

			// Should have an error message mentioning stderr content
			expect(events.some((e) =>
				e.type === "text-delta" && typeof e.delta === "string",
			)).toBe(true);
		});
	});

	// ── lifecycle events ──────────────────────────────────────────────

	describe("lifecycle events", () => {
		it("emits reasoning status on lifecycle start", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-lifecycle",
				message: "hi",
				agentSessionId: "s-lifecycle",
			});

			subscribeToRun(
				"s-lifecycle",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child._writeLine({
				event: "agent",
				stream: "lifecycle",
				data: { phase: "start" },
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(events.some((e) => e.type === "reasoning-start")).toBe(
				true,
			);
			expect(
				events.some(
					(e) =>
						e.type === "reasoning-delta" &&
						e.delta === "Preparing response...",
				),
			).toBe(true);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});
	});

	// ── Pinned agent ID ────────────────────────────────────────────────

	describe("pinned agent identity", () => {
		it("captures pinnedAgentId and pinnedSessionKey at run creation", async () => {
			const { startRun, getActiveRun } = await setup();

			startRun({
				sessionId: "s-pin",
				message: "hello",
				agentSessionId: "s-pin",
			});

			const run = getActiveRun("s-pin");
			expect(run).toBeDefined();
			expect(run?.pinnedAgentId).toBe("main");
			expect(run?.pinnedSessionKey).toBe("agent:main:web:s-pin");
		});

		it("uses overrideAgentId when provided", async () => {
			const { startRun, getActiveRun } = await setup();

			startRun({
				sessionId: "s-override",
				message: "hello",
				agentSessionId: "s-override",
				overrideAgentId: "chat-abc123",
			});

			const run = getActiveRun("s-override");
			expect(run?.pinnedAgentId).toBe("chat-abc123");
			expect(run?.pinnedSessionKey).toBe("agent:chat-abc123:web:s-override");
		});
	});

	// ── Chat frame forwarding ─────────────────────────────────────────

	describe("chat frame handling", () => {
		it("processes chat final events with assistant text", async () => {
			const { child, startRun, subscribeToRun } = await setup();

			const events: SseEvent[] = [];

			startRun({
				sessionId: "s-chat-frame",
				message: "run",
				agentSessionId: "s-chat-frame",
			});

			subscribeToRun(
				"s-chat-frame",
				(event) => {
					if (event) {events.push(event);}
				},
				{ replay: false },
			);

			child._writeLine({
				event: "chat",
				data: {
					state: "final",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Chat final text." }],
					},
				},
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(
				events.some(
					(e) =>
						e.type === "text-delta" &&
						typeof e.delta === "string" &&
						e.delta.includes("Chat final text."),
				),
			).toBe(true);

			child.stdout.end();
			await new Promise((r) => setTimeout(r, 50));
			child._emit("close", 0);
		});
	});
});
