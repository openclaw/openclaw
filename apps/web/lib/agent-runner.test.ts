import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./workspace", () => ({
	resolveActiveAgentId: () => "main",
	resolveOpenClawStateDir: () => "/tmp/__agent_runner_test_state",
}));

// Valid client IDs the Gateway accepts (from ui/src/ui/contracts/gateway-client-info.ts).
// Hardcoded here so the test breaks if our code drifts from the Gateway's enum.
const VALID_GATEWAY_CLIENT_IDS = new Set([
	"webchat-ui",
	"openclaw-control-ui",
	"webchat",
	"cli",
	"gateway-client",
	"openclaw-macos",
	"openclaw-ios",
	"openclaw-android",
	"node-host",
	"test",
	"fingerprint",
	"openclaw-probe",
]);

const VALID_GATEWAY_CLIENT_MODES = new Set([
	"webchat",
	"cli",
	"ui",
	"backend",
	"node",
	"probe",
	"test",
]);

/**
 * Mock that replaces the `ws` module's default export.
 * Mimics the ws package's EventEmitter-based API (.on, .once, .emit)
 * and tracks constructor args so we can assert on connection parameters.
 */
function installMockWsModule() {
	type ReqFrame = {
		type: "req";
		id: string;
		method: string;
		params?: unknown;
	};
	type ResFrame = {
		type: "res";
		id: string;
		ok: boolean;
		payload?: unknown;
		error?: unknown;
	};

	class MockNodeWebSocket extends EventEmitter {
		static OPEN = 1;
		static instances: MockNodeWebSocket[] = [];
		static responseOverrides: Record<
			string,
			ResFrame | ((frame: ReqFrame) => ResFrame)
		> = {};
		static failOpenForUrls = new Set<string>();

		readyState = 0;
		methods: string[] = [];
		requestFrames: ReqFrame[] = [];
		constructorUrl: string;
		constructorOpts: Record<string, unknown>;

		constructor(url: string, opts?: Record<string, unknown>) {
			super();
			this.constructorUrl = url;
			this.constructorOpts = opts ?? {};
			MockNodeWebSocket.instances.push(this);
			queueMicrotask(() => {
				if (MockNodeWebSocket.failOpenForUrls.has(this.constructorUrl)) {
					this.emit("error", new Error("mock gateway open failure"));
					return;
				}
				this.readyState = MockNodeWebSocket.OPEN;
				this.emit("open");
			});
		}

		send(payload: string) {
			const frame = JSON.parse(payload) as ReqFrame;
			this.methods.push(frame.method);
			this.requestFrames.push(frame);
			const override = MockNodeWebSocket.responseOverrides[frame.method];
			const resolved =
				typeof override === "function" ? override(frame) : override;
			const response = JSON.stringify(
				resolved ?? {
					type: "res",
					id: frame.id,
					ok: true,
					payload: {},
				},
			);
			this.emit("message", Buffer.from(response));
		}

		emitJson(frame: Record<string, unknown>) {
			this.emit("message", Buffer.from(JSON.stringify(frame)));
		}

		close() {
			this.readyState = 3;
			queueMicrotask(() => this.emit("close", 1000, Buffer.alloc(0)));
		}
	}

	vi.doMock("ws", () => ({
		default: MockNodeWebSocket,
		__esModule: true,
	}));

	return MockNodeWebSocket;
}

async function waitFor(
	predicate: () => boolean,
	options?: { attempts?: number; delayMs?: number },
): Promise<void> {
	const attempts = options?.attempts ?? 60;
	const delayMs = options?.delayMs ?? 10;
	for (let i = 0; i < attempts; i++) {
		if (predicate()) {
			return;
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}
	throw new Error("Condition not met in waitFor");
}

describe("agent-runner", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// ── buildConnectParams ───────────────────────────────────────────

	describe("buildConnectParams", () => {
		it("uses a client.id that the Gateway actually accepts (prevents connect rejection)", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				client: { id: string; mode: string };
			};
			expect(VALID_GATEWAY_CLIENT_IDS.has(params.client.id)).toBe(true);
		});

		it("uses a client.mode the Gateway accepts (prevents schema validation failure)", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				client: { id: string; mode: string };
			};
			expect(VALID_GATEWAY_CLIENT_MODES.has(params.client.mode)).toBe(true);
		});

		it("includes auth.token when settings have a token", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({
				url: "ws://127.0.0.1:19001",
				token: "secret-token",
			}) as { auth?: { token?: string; password?: string } };
			expect(params.auth?.token).toBe("secret-token");
		});

		it("includes auth.password when settings have a password", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({
				url: "ws://127.0.0.1:19001",
				password: "secret-pass",
			}) as { auth?: { token?: string; password?: string } };
			expect(params.auth?.password).toBe("secret-pass");
		});

		it("omits auth when no token or password is set", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				auth?: unknown;
			};
			expect(params.auth).toBeUndefined();
		});

		it("requests protocol version 3 (current Gateway protocol)", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				minProtocol: number;
				maxProtocol: number;
			};
			expect(params.minProtocol).toBe(3);
			expect(params.maxProtocol).toBe(3);
		});

		it("requests all 5 operator scopes for full gateway access (prevents missing-scope 403s)", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				scopes: string[];
			};
			expect(params.scopes).toEqual(
				expect.arrayContaining([
					"operator.admin",
					"operator.approvals",
					"operator.pairing",
					"operator.read",
					"operator.write",
				]),
			);
			expect(params.scopes).toHaveLength(5);
		});

		it("uses backend mode so sessions.patch is allowed", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				client: { mode: string };
			};
			expect(params.client.mode).toBe("backend");
		});

		it("advertises tool-events capability for tool stream parity", async () => {
			const { buildConnectParams } = await import("./agent-runner.js");
			const params = buildConnectParams({ url: "ws://127.0.0.1:19001" }) as {
				caps?: string[];
			};
			expect(Array.isArray(params.caps)).toBe(true);
			expect(params.caps).toContain("tool-events");
		});
	});

	// ── spawnAgentProcess (ws transport) ─────────────────────────────

	describe("spawnAgentProcess", () => {
		it("connects via ws module and issues connect, sessions.patch, chat.send RPCs in order", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-1");
			await waitFor(() =>  MockWs.instances[0]?.methods.includes("chat.send"));

			const ws = MockWs.instances[0];
			expect(ws).toBeDefined();
			expect(ws.constructorUrl).toMatch(/^ws:\/\//);

			expect(ws.methods).toContain("connect");
			expect(ws.methods).toContain("sessions.patch");
			expect(ws.methods).toContain("chat.send");
			expect(ws.methods.slice(0, 3)).toEqual(["connect", "sessions.patch", "chat.send"]);
			proc.kill("SIGTERM");
		});

		it("patches the selected Dench Cloud model before sending the chat request", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-model", undefined, "gpt-5.4");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));

			const ws = MockWs.instances[0];
			const patchFrame = ws.requestFrames.find(
				(frame) => frame.method === "sessions.patch",
			);
			const sendFrame = ws.requestFrames.find(
				(frame) => frame.method === "chat.send",
			);

			expect(patchFrame?.params).toMatchObject({
				key: "agent:main:web:sess-model",
				model: "dench-cloud/gpt-5.4",
			});
			expect(sendFrame?.params).toMatchObject({
				message: "hello",
				sessionKey: "agent:main:web:sess-model",
			});
			expect(sendFrame?.params).not.toHaveProperty("model");

			proc.kill("SIGTERM");
		});

		it("connects to wss: URL for TLS gateways", async () => {
			const MockWs = installMockWsModule();
			process.env.OPENCLAW_GATEWAY_URL = "wss://gateway.example.com:443";
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello");
			await waitFor(() =>  MockWs.instances[0]?.methods.includes("connect"));

			const ws = MockWs.instances[0];
			expect(ws.constructorUrl).toMatch(/^wss:\/\/gateway\.example\.com/);
			proc.kill("SIGTERM");
		});

		it("falls back to config gateway port when env port is stale", async () => {
			const MockWs = installMockWsModule();
			process.env.OPENCLAW_HOME = "/tmp/__ironclaw_agent_runner_test_no_config";
			process.env.OPENCLAW_GATEWAY_PORT = "19001";
			MockWs.failOpenForUrls.add("ws://127.0.0.1:19001/");

			const { spawnAgentProcess } = await import("./agent-runner.js");
			const proc = spawnAgentProcess("hello");

			await waitFor(
				() =>  MockWs.instances.length >= 2,
				{ attempts: 80, delayMs: 10 },
			);

			const [primaryAttempt] = MockWs.instances;
			const fallbackAttempt = MockWs.instances.find(
				(instance) => instance.constructorUrl !== primaryAttempt?.constructorUrl,
			);
			expect(primaryAttempt?.constructorUrl).toBe("ws://127.0.0.1:19001/");
			expect(fallbackAttempt).toBeDefined();

			await waitFor(
				() =>  Boolean(fallbackAttempt?.methods.includes("connect")),
				{ attempts: 80, delayMs: 10 },
			);

			proc.kill("SIGTERM");
		});

		it("keeps stream open across lifecycle error and accepts continuation runId", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-lifeerr");
			await waitFor(() =>  MockWs.instances[0]?.methods.includes("chat.send"));
			const ws = MockWs.instances[0];

			let stdout = "";
			let closed = false;
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			proc.on("close", () => {
				closed = true;
			});

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 1,
				payload: {
					runId: "r-initial",
					sessionKey: "agent:main:web:sess-lifeerr",
					stream: "lifecycle",
					data: { phase: "error" },
					globalSeq: 1,
					ts: Date.now(),
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(closed).toBe(false);

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 2,
				payload: {
					runId: "r-continuation",
					sessionKey: "agent:main:web:sess-lifeerr",
					stream: "assistant",
					data: { delta: "continued-output" },
					globalSeq: 2,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("continued-output"), {
				attempts: 80,
				delayMs: 10,
			});
			proc.kill("SIGTERM");
		});

		it("reconnects and resumes the active session after a transient 1006 close", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-reconnect");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));
			const firstWs = MockWs.instances[0];

			let stdout = "";
			let closed = false;
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			proc.on("close", () => {
				closed = true;
			});

			firstWs.emitJson({
				type: "event",
				event: "agent",
				seq: 1,
				payload: {
					runId: "r-reconnect",
					sessionKey: "agent:main:web:sess-reconnect",
					stream: "assistant",
					data: { delta: "before-drop" },
					globalSeq: 1,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("before-drop"), {
				attempts: 80,
				delayMs: 10,
			});

			firstWs.emit("close", 1006, Buffer.alloc(0));

			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(closed).toBe(false);

			await waitFor(() => MockWs.instances.length >= 2, {
				attempts: 160,
				delayMs: 10,
			});
			const secondWs = MockWs.instances[1];

			await waitFor(() => secondWs?.methods.includes("agent.subscribe"), {
				attempts: 80,
				delayMs: 10,
			});

			const subscribeFrame = secondWs.requestFrames.find(
				(frame) => frame.method === "agent.subscribe",
			);
			expect(subscribeFrame?.params).toMatchObject({
				sessionKey: "agent:main:web:sess-reconnect",
				afterSeq: 1,
			});

			secondWs.emitJson({
				type: "event",
				event: "agent",
				seq: 2,
				payload: {
					runId: "r-reconnect",
					sessionKey: "agent:main:web:sess-reconnect",
					stream: "assistant",
					data: { delta: "after-reconnect" },
					globalSeq: 2,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("after-reconnect"), {
				attempts: 80,
				delayMs: 10,
			});

			secondWs.emitJson({
				type: "event",
				event: "agent",
				seq: 3,
				payload: {
					runId: "r-reconnect",
					sessionKey: "agent:main:web:sess-reconnect",
					stream: "lifecycle",
					data: { phase: "end" },
					globalSeq: 3,
					ts: Date.now(),
				},
			});

			await waitFor(() => closed, { attempts: 120, delayMs: 10 });
		});

		it("clears a pending reconnect timer when the process is killed", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-stop-reconnect");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));
			const firstWs = MockWs.instances[0];

			let closed = false;
			proc.on("close", () => {
				closed = true;
			});

			firstWs.emit("close", 1006, Buffer.alloc(0));
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(proc.kill("SIGTERM")).toBe(true);
			await waitFor(() => closed, { attempts: 80, delayMs: 10 });

			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(MockWs.instances).toHaveLength(1);
		});

		it("uses chat.send RPC for slash commands instead of agent", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("/status", "sess-cmd");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));

			const ws = MockWs.instances[0];
			expect(ws.methods).toContain("connect");
			expect(ws.methods).toContain("chat.send");
			expect(ws.methods).not.toContain("agent");

			const chatSendFrame = ws.requestFrames.find(
				(frame) => frame.method === "chat.send",
			);
			const params = chatSendFrame?.params as Record<string, unknown>;
			expect(params.message).toBe("/status");
			expect(params.deliver).toBe(false);
			expect(typeof params.idempotencyKey).toBe("string");
			expect((params.idempotencyKey as string).length).toBeGreaterThan(0);
			proc.kill("SIGTERM");
		});

		it("uses chat.send RPC for regular (non-slash) messages", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello world", "sess-reg");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));

			const ws = MockWs.instances[0];
			expect(ws.methods).toContain("chat.send");
			expect(ws.methods).not.toContain("agent");

			const chatSendFrame = ws.requestFrames.find(
				(frame) => frame.method === "chat.send",
			);
			const params = chatSendFrame?.params as Record<string, unknown>;
			expect(params.message).toBe("hello world");
			expect(params.deliver).toBe(false);
			proc.kill("SIGTERM");
		});

		it("forwards chat final events to stdout for slash commands", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("/status", "sess-chatfinal");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));
			const ws = MockWs.instances[0];

			let stdout = "";
			let closed = false;
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			proc.on("close", () => {
				closed = true;
			});

			ws.emitJson({
				type: "event",
				event: "chat",
				seq: 1,
				payload: {
					state: "final",
					message: {
						role: "assistant",
						content: "Status: all systems go",
					},
					sessionKey: "agent:main:web:sess-chatfinal",
					globalSeq: 1,
				},
			});

			await waitFor(() => stdout.includes("state"), {
				attempts: 80,
				delayMs: 10,
			});
			const parsed = JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, unknown>;
			expect(parsed.event).toBe("chat");
			expect((parsed.data as Record<string, unknown>).state).toBe("final");

			await waitFor(() => closed, { attempts: 80, delayMs: 10 });
		});

		it("suppresses chat events once agent events arrive in start mode", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentProcess } = await import("./agent-runner.js");

			const proc = spawnAgentProcess("hello", "sess-nochat");
			await waitFor(() => MockWs.instances[0]?.methods.includes("chat.send"));
			const ws = MockWs.instances[0];

			let stdout = "";
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 1,
				payload: {
					runId: "r-nochat",
					sessionKey: "agent:main:web:sess-nochat",
					stream: "assistant",
					data: { delta: "agent-output" },
					globalSeq: 1,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("agent-output"), { attempts: 80, delayMs: 10 });

			ws.emitJson({
				type: "event",
				event: "chat",
				seq: 2,
				payload: {
					state: "final",
					message: {
						role: "assistant",
						content: "should be ignored",
					},
					sessionKey: "agent:main:web:sess-nochat",
					globalSeq: 2,
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(stdout).not.toContain("should be ignored");
			proc.kill("SIGTERM");
		});

	});

	describe("spawnAgentSubscribeProcess", () => {
		it("subscribes via connect -> sessions.patch -> agent.subscribe", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const proc = spawnAgentSubscribeProcess("agent:main:web:sess-sub", 12);
			await waitFor(
				() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"),
				{ attempts: 80, delayMs: 10 },
			);

			const ws = MockWs.instances[0];
			expect(ws.methods.slice(0, 3)).toEqual([
				"connect",
				"sessions.patch",
				"agent.subscribe",
			]);
			const subscribeFrame = ws.requestFrames.find(
				(frame) => frame.method === "agent.subscribe",
			);
			expect(subscribeFrame?.params).toMatchObject({
				sessionKey: "agent:main:web:sess-sub",
				afterSeq: 12,
			});
			proc.kill("SIGTERM");
		});

		it("uses payload.globalSeq (not frame seq) for cursor filtering", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const proc = spawnAgentSubscribeProcess("agent:main:web:sess-gseq", 5);
			await waitFor(
				() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"),
				{ attempts: 80, delayMs: 10 },
			);
			const ws = MockWs.instances[0];

			let stdout = "";
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});

			// Drop: payload.globalSeq <= afterSeq
			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 100,
				payload: {
					runId: "r-gseq",
					sessionKey: "agent:main:web:sess-gseq",
					stream: "assistant",
					data: { delta: "old" },
					seq: 1,
					ts: Date.now(),
					globalSeq: 5,
				},
			});
			// Keep: payload.globalSeq > afterSeq even if frame.seq is smaller
			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 3,
				payload: {
					runId: "r-gseq",
					sessionKey: "agent:main:web:sess-gseq",
					stream: "assistant",
					data: { delta: "new" },
					seq: 2,
					ts: Date.now(),
					globalSeq: 6,
				},
			});

			await waitFor(() => stdout.includes("\n"), { attempts: 80, delayMs: 10 });
			const lines = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0]) as {
				globalSeq?: number;
				data?: { delta?: string };
			};
			expect(parsed.globalSeq).toBe(6);
			expect(parsed.data?.delta).toBe("new");
			proc.kill("SIGTERM");
		});

		it("keeps subscribe workers alive across lifecycle end events", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const proc = spawnAgentSubscribeProcess("agent:main:web:sess-sticky", 0);
			await waitFor(
				() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"),
				{ attempts: 80, delayMs: 10 },
			);
			const ws = MockWs.instances[0];

			let stdout = "";
			let closed = false;
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			proc.on("close", () => {
				closed = true;
			});

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 10,
				payload: {
					runId: "r-sticky",
					sessionKey: "agent:main:web:sess-sticky",
					stream: "lifecycle",
					data: { phase: "end" },
					globalSeq: 10,
					ts: Date.now(),
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(closed).toBe(false);

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 11,
				payload: {
					runId: "r-sticky",
					sessionKey: "agent:main:web:sess-sticky",
					stream: "assistant",
					data: { delta: "after-end" },
					globalSeq: 11,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("after-end"), { attempts: 80, delayMs: 10 });
			proc.kill("SIGTERM");
		});

		it("drops subscribe events missing a matching session key", async () => {
			const MockWs = installMockWsModule();
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const proc = spawnAgentSubscribeProcess("agent:main:web:sess-filter", 0);
			await waitFor(
				() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"),
				{ attempts: 80, delayMs: 10 },
			);
			const ws = MockWs.instances[0];

			let stdout = "";
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 1,
				payload: {
					runId: "r-filter",
					stream: "assistant",
					data: { delta: "missing-session" },
					globalSeq: 1,
					ts: Date.now(),
				},
			});
			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 2,
				payload: {
					runId: "r-filter",
					sessionKey: "agent:main:web:sess-filter",
					stream: "assistant",
					data: { delta: "accepted-session" },
					globalSeq: 2,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("accepted-session"), {
				attempts: 80,
				delayMs: 10,
			});
			expect(stdout).not.toContain("missing-session");
			proc.kill("SIGTERM");
		});

		it("falls back to passive mode when agent.subscribe is unsupported", async () => {
			const MockWs = installMockWsModule();
			MockWs.responseOverrides["agent.subscribe"] = (frame) => ({
				type: "res",
				id: frame.id,
				ok: false,
				error: { message: "unknown method: agent.subscribe" },
			});
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const proc = spawnAgentSubscribeProcess("agent:main:web:sess-passive", 0);
			await waitFor(() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"));

			const ws = MockWs.instances[0];
			let stdout = "";
			proc.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});

			ws.emitJson({
				type: "event",
				event: "agent",
				seq: 8,
				payload: {
					runId: "r-passive",
					sessionKey: "agent:main:web:sess-passive",
					stream: "assistant",
					data: { delta: "passive works" },
					globalSeq: 8,
					ts: Date.now(),
				},
			});

			await waitFor(() => stdout.includes("passive works"), {
				attempts: 80,
				delayMs: 10,
			});
			proc.kill("SIGTERM");
		});

		it("caches unsupported agent.subscribe and skips retrying it", async () => {
			const MockWs = installMockWsModule();
			MockWs.responseOverrides["agent.subscribe"] = (frame) => ({
				type: "res",
				id: frame.id,
				ok: false,
				error: { message: "unknown method: agent.subscribe" },
			});
			const { spawnAgentSubscribeProcess } = await import("./agent-runner.js");

			const first = spawnAgentSubscribeProcess("agent:main:web:sess-cache", 0);
			await waitFor(() =>  MockWs.instances[0]?.methods.includes("agent.subscribe"));
			first.kill("SIGTERM");

			const second = spawnAgentSubscribeProcess("agent:main:web:sess-cache", 0);
			await waitFor(() => MockWs.instances.length >= 2);
			await new Promise((r) => setTimeout(r, 20));
			const secondMethods = MockWs.instances[1]?.methods ?? [];
			expect(secondMethods).toContain("connect");
			expect(secondMethods).toContain("sessions.patch");
			expect(secondMethods).not.toContain("agent.subscribe");
			second.kill("SIGTERM");
		});
	});

	// ── enhanceScopeError ─────────────────────────────────────────────

	describe("enhanceScopeError", () => {
		it("returns actionable message for 'missing scope: operator.write'", async () => {
			const { enhanceScopeError } = await import("./agent-runner.js");
			const result = enhanceScopeError("missing scope: operator.write");
			expect(result).toContain("missing scope: operator.write");
			expect(result).toContain("npx denchclaw bootstrap");
			expect(result).toContain("device identity");
		});

		it("returns actionable message for 'missing scope: operator.read'", async () => {
			const { enhanceScopeError } = await import("./agent-runner.js");
			const result = enhanceScopeError("missing scope: operator.read");
			expect(result).toContain("missing scope: operator.read");
			expect(result).toContain("npx denchclaw bootstrap");
		});

		it("returns null for non-scope errors", async () => {
			const { enhanceScopeError } = await import("./agent-runner.js");
			expect(enhanceScopeError("connection timeout")).toBeNull();
			expect(enhanceScopeError("unauthorized")).toBeNull();
			expect(enhanceScopeError("")).toBeNull();
		});
	});

	// ── scope error during connect ───────────────────────────────────

	describe("scope error handling", () => {
		it("emits enhanced error when connect fails with missing scope", async () => {
			const MockWs = installMockWsModule();
			MockWs.responseOverrides["connect"] = (frame) => ({
				type: "res",
				id: frame.id,
				ok: false,
				error: { message: "missing scope: operator.write" },
			});
			const { spawnAgentProcess } = await import("./agent-runner.js");

			let stderr = "";
			let errorEmitted = false;
			const proc = spawnAgentProcess("hello", "sess-scope-connect");
			proc.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			proc.on("error", () => {
				errorEmitted = true;
			});

			await waitFor(() => errorEmitted, { attempts: 80, delayMs: 10 });
			expect(stderr).toContain("missing scope: operator.write");
			expect(stderr).toContain("npx denchclaw bootstrap");
			proc.kill("SIGTERM");
		});

		it("emits enhanced error when chat.send RPC fails with missing scope", async () => {
			const MockWs = installMockWsModule();
			MockWs.responseOverrides["chat.send"] = (frame) => ({
				type: "res",
				id: frame.id,
				ok: false,
				error: { message: "missing scope: operator.write" },
			});
			const { spawnAgentProcess } = await import("./agent-runner.js");

			let stderr = "";
			let errorEmitted = false;
			const proc = spawnAgentProcess("hello", "sess-scope-agent");
			proc.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			proc.on("error", () => {
				errorEmitted = true;
			});

			await waitFor(() => errorEmitted, { attempts: 80, delayMs: 10 });
			expect(stderr).toContain("missing scope: operator.write");
			expect(stderr).toContain("device identity");
			proc.kill("SIGTERM");
		});

		it("does not alter non-scope errors", async () => {
			const MockWs = installMockWsModule();
			MockWs.responseOverrides["connect"] = (frame) => ({
				type: "res",
				id: frame.id,
				ok: false,
				error: { message: "unauthorized: bad token" },
			});
			const { spawnAgentProcess } = await import("./agent-runner.js");

			let stderr = "";
			let errorEmitted = false;
			const proc = spawnAgentProcess("hello", "sess-nonscopeErr");
			proc.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			proc.on("error", () => {
				errorEmitted = true;
			});

			await waitFor(() => errorEmitted, { attempts: 80, delayMs: 10 });
			expect(stderr).toContain("unauthorized: bad token");
			expect(stderr).not.toContain("npx denchclaw bootstrap");
			proc.kill("SIGTERM");
		});
	});

	// ── parseAgentErrorMessage ────────────────────────────────────────

	describe("parseAgentErrorMessage", () => {
		it("extracts message from error field", async () => {
			const { parseAgentErrorMessage } = await import("./agent-runner.js");
			expect(parseAgentErrorMessage({ error: "something went wrong" })).toBe(
				"something went wrong",
			);
		});

		it("extracts message from JSON error body", async () => {
			const { parseAgentErrorMessage } = await import("./agent-runner.js");
			const result = parseAgentErrorMessage({
				errorMessage: '402 {"error":{"message":"Insufficient funds"}}',
			});
			expect(result).toBe("Insufficient funds");
		});

		it("returns undefined for empty data", async () => {
			const { parseAgentErrorMessage } = await import("./agent-runner.js");
			expect(parseAgentErrorMessage(undefined)).toBeUndefined();
			expect(parseAgentErrorMessage({})).toBeUndefined();
		});
	});

	// ── parseErrorFromStderr ─────────────────────────────────────────

	describe("parseErrorFromStderr", () => {
		it("extracts JSON error message from stderr", async () => {
			const { parseErrorFromStderr } = await import("./agent-runner.js");
			const stderr = `Some log line\n{"error":{"message":"Rate limit exceeded"}}\n`;
			expect(parseErrorFromStderr(stderr)).toBe("Rate limit exceeded");
		});

		it("returns undefined for empty stderr", async () => {
			const { parseErrorFromStderr } = await import("./agent-runner.js");
			expect(parseErrorFromStderr("")).toBeUndefined();
		});
	});

	// ── parseErrorBody ───────────────────────────────────────────────

	describe("parseErrorBody", () => {
		it("extracts error message from JSON error body", async () => {
			const { parseErrorBody } = await import("./agent-runner.js");
			expect(parseErrorBody('{"error":{"message":"Something failed"}}')).toBe(
				"Something failed",
			);
		});

		it("returns raw string for non-JSON body", async () => {
			const { parseErrorBody } = await import("./agent-runner.js");
			expect(parseErrorBody("plain text error")).toBe("plain text error");
		});
	});
});
