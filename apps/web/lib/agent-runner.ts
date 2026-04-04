import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import NodeWebSocket from "ws";
import {
	resolveActiveAgentId,
	resolveOpenClawStateDir,
} from "./workspace";

export type AgentEvent = {
	event: string;
	runId?: string;
	stream?: string;
	data?: Record<string, unknown>;
	seq?: number;
	globalSeq?: number;
	ts?: number;
	sessionKey?: string;
	status?: string;
	result?: {
		payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
		meta?: Record<string, unknown>;
	};
};

/** Extracted text + details from a tool result event. */
export type ToolResult = {
	text?: string;
	details?: Record<string, unknown>;
};

/**
 * Extract text content from the agent's tool result object.
 * The result has `content: Array<{ type: "text", text: string } | ...>` and
 * optional `details` (exit codes, file paths, etc.).
 *
 * Falls back gracefully when the result doesn't follow the standard wrapper:
 * - If no `content` array, tries to use the raw object as details directly.
 * - If the raw value is a string, treats it as text.
 */
export function extractToolResult(
	raw: unknown,
): ToolResult | undefined {
	if (!raw) {return undefined;}
	// String result — treat the whole thing as text
	if (typeof raw === "string") {return { text: raw, details: undefined };}
	if (typeof raw !== "object") {return undefined;}
	const r = raw as Record<string, unknown>;

	// Extract text from content blocks
	const content = Array.isArray(r.content) ? r.content : [];
	const textParts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as Record<string, unknown>).type === "text" &&
			typeof (block as Record<string, unknown>).text === "string"
		) {
			textParts.push((block as Record<string, unknown>).text as string);
		}
	}

	const text = textParts.length > 0 ? textParts.join("\n") : undefined;
	const details =
		r.details && typeof r.details === "object"
			? (r.details as Record<string, unknown>)
			: undefined;

	// Fallback: if neither content nor details were found, the raw object
	// might BE the tool payload itself (e.g. { query, results, url, ... }).
	// Use it as details so buildToolOutput can extract web tool fields.
	if (!text && !details && !Array.isArray(r.content)) {
		return { text: undefined, details: r };
	}

	return { text, details };
}

export type AgentProcessHandle = {
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	kill: (signal?: NodeJS.Signals | number) => boolean;
	on: {
		(
			event: "close",
			listener: (code: number | null, signal: NodeJS.Signals | null) => void,
		): AgentProcessHandle;
		(event: string, listener: (...args: unknown[]) => void): AgentProcessHandle;
	};
	once: {
		(
			event: "close",
			listener: (code: number | null, signal: NodeJS.Signals | null) => void,
		): AgentProcessHandle;
		(event: string, listener: (...args: unknown[]) => void): AgentProcessHandle;
	};
};

type GatewayReqFrame = {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
};

type GatewayResFrame = {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: unknown;
};

type GatewayEventFrame = {
	type: "event";
	event: string;
	seq?: number;
	payload?: unknown;
};

type GatewayFrame =
	| GatewayReqFrame
	| GatewayResFrame
	| GatewayEventFrame
	| { type?: string; [key: string]: unknown };

type GatewayConnectionSettings = {
	url: string;
	token?: string;
	password?: string;
};

type PendingGatewayRequest = {
	resolve: (value: GatewayResFrame) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

type SpawnGatewayProcessParams = {
	mode: "start" | "subscribe";
	message?: string;
	sessionKey?: string;
	afterSeq: number;
	lane?: string;
	modelOverride?: string;
};

type BuildConnectParamsOptions = {
	clientMode?: "webchat" | "backend" | "cli" | "ui" | "node" | "probe" | "test";
	caps?: string[];
	nonce?: string;
	deviceIdentity?: DeviceIdentity | null;
	deviceToken?: string | null;
};

const DEFAULT_GATEWAY_PORT = 18_789;
const OPEN_TIMEOUT_MS = 8_000;
const CHALLENGE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_GATEWAY_CLIENT_CAPS = ["tool-events"];
const SESSIONS_PATCH_RETRY_DELAY_MS = 150;
const SESSIONS_PATCH_MAX_ATTEMPTS = 2;
const LIFECYCLE_ERROR_RECOVERY_MS = 15_000;
const GATEWAY_RECONNECT_BASE_MS = 300;
const GATEWAY_RECONNECT_MAX_MS = 5_000;
const GATEWAY_RECONNECT_MAX_ATTEMPTS = 6;
const GATEWAY_RPC_RETRY_BASE_MS = 250;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RETRYABLE_GATEWAY_CLOSE_CODES = new Set([1000, 1005, 1006, 1012]);

function normalizeModelOverride(modelOverride?: string): string | undefined {
	if (typeof modelOverride !== "string" || !modelOverride.trim()) {
		return undefined;
	}
	const normalized = modelOverride.trim();
	return normalized.startsWith("dench-cloud/")
		? normalized
		: `dench-cloud/${normalized}`;
}

type AgentSubscribeSupport = "unknown" | "supported" | "unsupported";
let cachedAgentSubscribeSupport: AgentSubscribeSupport = "unknown";

type DeviceIdentity = {
	deviceId: string;
	publicKeyPem: string;
	privateKeyPem: string;
};

type DeviceAuth = {
	deviceId: string;
	token: string;
	scopes: string[];
};

function base64UrlEncode(buf: Buffer): string {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
	const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
	if (
		spki.length === ED25519_SPKI_PREFIX.length + 32 &&
		spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
	) {
		return spki.subarray(ED25519_SPKI_PREFIX.length);
	}
	return spki;
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
	const key = createPrivateKey(privateKeyPem);
	return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

function loadDeviceIdentity(stateDir: string): DeviceIdentity | null {
	const filePath = join(stateDir, "identity", "device.json");
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
		if (
			parsed &&
			typeof parsed.deviceId === "string" &&
			typeof parsed.publicKeyPem === "string" &&
			typeof parsed.privateKeyPem === "string"
		) {
			return {
				deviceId: parsed.deviceId,
				publicKeyPem: parsed.publicKeyPem,
				privateKeyPem: parsed.privateKeyPem,
			};
		}
	} catch { /* ignore */ }
	return null;
}

function loadDeviceAuth(stateDir: string): DeviceAuth | null {
	const filePath = join(stateDir, "identity", "device-auth.json");
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const parsed = parseJsonObject(readFileSync(filePath, "utf-8"));
		if (!parsed || typeof parsed.deviceId !== "string") {
			return null;
		}
		const tokens = asRecord(parsed.tokens);
		const operator = asRecord(tokens?.operator);
		if (operator && typeof operator.token === "string") {
			return {
				deviceId: parsed.deviceId,
				token: operator.token,
				scopes: Array.isArray(operator.scopes) ? (operator.scopes as string[]) : [],
			};
		}
	} catch { /* ignore */ }
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return asRecord(parsed);
	} catch {
		return null;
	}
}

function parsePort(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function normalizeWsUrl(raw: string, fallbackPort: number): string {
	const withScheme = raw.includes("://") ? raw : `ws://${raw}`;
	const url = new URL(withScheme);
	if (url.protocol === "http:") {
		url.protocol = "ws:";
	} else if (url.protocol === "https:") {
		url.protocol = "wss:";
	}
	if (!url.port) {
		url.port = url.protocol === "wss:" ? "443" : String(fallbackPort);
	}
	return url.toString();
}

function readGatewayConfigFromStateDir(
	stateDir: string,
): Record<string, unknown> | null {
	const candidates = [join(stateDir, "openclaw.json"), join(stateDir, "config.json")];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) {
			continue;
		}
		try {
			const parsed = parseJsonObject(readFileSync(candidate, "utf-8"));
			if (parsed) {
				return parsed;
			}
		} catch {
			// Ignore malformed config and continue to fallback behavior.
		}
	}
	return null;
}

function resolveGatewayConnectionCandidates(): GatewayConnectionSettings[] {
	const envUrl = process.env.OPENCLAW_GATEWAY_URL?.trim();
	const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
	const envPassword = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
	const envPort = parsePort(process.env.OPENCLAW_GATEWAY_PORT);

	const stateDir = resolveOpenClawStateDir();
	const config = readGatewayConfigFromStateDir(stateDir);
	const gateway = asRecord(config?.gateway);
	const remote = asRecord(gateway?.remote);
	const auth = asRecord(gateway?.auth);

	const configGatewayPort = parsePort(gateway?.port) ?? DEFAULT_GATEWAY_PORT;
	const gatewayPort = envPort ?? configGatewayPort;
	const gatewayMode =
		typeof gateway?.mode === "string" ? gateway.mode.trim().toLowerCase() : "";
	const remoteUrl =
		typeof remote?.url === "string" ? remote.url.trim() : undefined;
	const useRemote = !envUrl && gatewayMode === "remote" && Boolean(remoteUrl);

	const configToken =
		(useRemote && typeof remote?.token === "string"
			? remote.token.trim()
			: undefined) ||
		(typeof auth?.token === "string" ? auth.token.trim() : undefined);

	const configPassword =
		(useRemote && typeof remote?.password === "string"
			? remote.password.trim()
			: undefined) ||
		(typeof auth?.password === "string" ? auth.password.trim() : undefined);

	const primaryRawUrl = envUrl || (useRemote ? remoteUrl! : `ws://127.0.0.1:${gatewayPort}`);
	const primary: GatewayConnectionSettings = {
		url: normalizeWsUrl(primaryRawUrl, gatewayPort),
		token: envToken || configToken,
		password: envPassword || configPassword,
	};

	const configRawUrl = useRemote
		? remoteUrl!
		: `ws://127.0.0.1:${configGatewayPort}`;
	const fallback: GatewayConnectionSettings = {
		url: normalizeWsUrl(configRawUrl, configGatewayPort),
		token: configToken,
		password: configPassword,
	};

	const candidates = [primary];
	if (fallback.url !== primary.url) {
		candidates.push(fallback);
	}

	const deduped: GatewayConnectionSettings[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = `${candidate.url}|${candidate.token ?? ""}|${candidate.password ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(candidate);
	}
	return deduped;
}

export function buildConnectParams(
	settings: GatewayConnectionSettings,
	options?: BuildConnectParamsOptions,
): Record<string, unknown> {
	const optionCaps = options?.caps;
	const caps = Array.isArray(optionCaps)
		? optionCaps.filter(
				(cap): cap is string => typeof cap === "string" && cap.trim().length > 0,
			)
		: DEFAULT_GATEWAY_CLIENT_CAPS;
	const clientMode = options?.clientMode ?? "backend";
	const clientId = process.env.OPENCLAW_GATEWAY_CLIENT_ID || "gateway-client";
	const role = "operator";
	const scopes = [
		"operator.admin",
		"operator.approvals",
		"operator.pairing",
		"operator.read",
		"operator.write",
	];

	const hasGatewayAuth = Boolean(settings.token || settings.password);
	const deviceToken = options?.deviceToken;
	const auth = hasGatewayAuth || deviceToken
		? {
				...(settings.token ? { token: settings.token } : {}),
				...(settings.password ? { password: settings.password } : {}),
				...(deviceToken ? { deviceToken } : {}),
			}
		: undefined;

	const nonce = options?.nonce;
	const identity = options?.deviceIdentity;
	let device: Record<string, unknown> | undefined;
	if (identity && nonce) {
		const signedAtMs = Date.now();
		const platform = process.platform;
		const payload = [
			"v3",
			identity.deviceId,
			clientId,
			clientMode,
			role,
			scopes.join(","),
			String(signedAtMs),
			settings.token ?? "",
			nonce,
			platform,
			"",
		].join("|");
		const signature = signDevicePayload(identity.privateKeyPem, payload);
		device = {
			id: identity.deviceId,
			publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
			signature,
			signedAt: signedAtMs,
			nonce,
		};
	}

	return {
		minProtocol: 3,
		maxProtocol: 3,
		client: {
			id: clientId,
			version: "dev",
			platform: process.platform,
			mode: clientMode,
			instanceId: "denchclaw-web-server",
		},
		locale: "en-US",
		userAgent: "denchclaw-web",
		role,
		scopes,
		caps,
		...(auth ? { auth } : {}),
		...(device ? { device } : {}),
	};
}

function frameErrorMessage(frame: GatewayResFrame): string {
	const error = asRecord(frame.error);
	if (typeof error?.message === "string" && error.message.trim()) {
		return error.message;
	}
	if (typeof frame.error === "string" && frame.error.trim()) {
		return frame.error;
	}
	return "Gateway request failed";
}

function isUnknownMethodResponse(
	frame: GatewayResFrame,
	methodName: string,
): boolean {
	const message = frameErrorMessage(frame).trim().toLowerCase();
	if (!message.includes("unknown method")) {
		return false;
	}
	return message.includes(methodName.toLowerCase());
}

function isRetryableGatewayMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return (
		normalized.includes("timeout") ||
		normalized.includes("timed out") ||
		normalized.includes("temporar") ||
		normalized.includes("unavailable") ||
		normalized.includes("try again") ||
		normalized.includes("connection closed") ||
		normalized.includes("connection reset")
	);
}

function isRetryableGatewayCloseCode(code: number): boolean {
	return RETRYABLE_GATEWAY_CLOSE_CODES.has(code);
}

function isRetryableGatewayTransportError(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return (
		normalized.includes("gateway connection closed") ||
		normalized.includes("gateway websocket connection failed") ||
		normalized.includes("gateway websocket open timeout") ||
		normalized.includes("code 1000") ||
		normalized.includes("code 1005") ||
		normalized.includes("code 1006") ||
		normalized.includes("code 1012") ||
		normalized.includes("closed (1000") ||
		normalized.includes("closed (1005") ||
		normalized.includes("closed (1006") ||
		normalized.includes("closed (1012")
	);
}

const MISSING_SCOPE_RE = /missing scope:\s*(\S+)/i;

/**
 * Detect "missing scope: ..." errors from the Gateway and return an
 * actionable message. The Gateway requires device identity for scope grants;
 * this error means the device keypair at ~/.openclaw-dench/identity/ is
 * missing or invalid.
 */
export function enhanceScopeError(raw: string): string | null {
	const match = MISSING_SCOPE_RE.exec(raw);
	if (!match) {
		return null;
	}
	const scope = match[1];
	return [
		`missing scope: ${scope}.`,
		"The Gateway did not grant operator scopes — device identity may be missing or invalid.",
		"Fix: run `npx denchclaw bootstrap` to re-pair the device.",
	].join(" ");
}

function toMessageText(data: unknown): string | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf-8");
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
			"utf-8",
		);
	}
	return null;
}

class GatewayWsClient {
	private ws: NodeWebSocket | null = null;
	private pending = new Map<string, PendingGatewayRequest>();
	private closed = false;
	private challengeNonce: string | null = null;
	private challengeResolve: ((nonce: string) => void) | null = null;

	constructor(
		private readonly settings: GatewayConnectionSettings,
		private readonly onEvent: (frame: GatewayEventFrame) => void,
		private readonly onClose: (code: number, reason: string) => void,
	) {}

	waitForChallenge(timeoutMs = CHALLENGE_TIMEOUT_MS): Promise<string> {
		if (this.challengeNonce) {
			return Promise.resolve(this.challengeNonce);
		}
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.challengeResolve = null;
				reject(new Error("Gateway challenge timeout"));
			}, timeoutMs);
			this.challengeResolve = (nonce: string) => {
				clearTimeout(timer);
				resolve(nonce);
			};
		});
	}

	async open(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
		if (this.ws) {
			return;
		}
		const ws = new NodeWebSocket(this.settings.url, { origin: this.settings.url });
		this.ws = ws;

		// Attach message/close handlers BEFORE awaiting "open" so that
		// events sent immediately after the handshake (e.g. connect.challenge)
		// are never lost to a listener-attachment race.
		ws.on("message", (data: NodeWebSocket.RawData) => {
			const text = toMessageText(data);
			if (text != null) {
				this.handleMessageText(text);
			}
		});

		ws.on("close", (code: number, reason: Buffer) => {
			if (this.closed) {
				return;
			}
			this.closed = true;
			this.flushPending(new Error("Gateway connection closed"));
			this.onClose(code, reason.toString("utf-8"));
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				reject(new Error("Gateway WebSocket open timeout"));
			}, timeoutMs);

			const onOpen = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve();
			};

			const onError = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				reject(new Error("Gateway WebSocket connection failed"));
			};

			ws.once("open", onOpen);
			ws.once("error", onError);
		});
	}

	request(
		method: string,
		params?: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<GatewayResFrame> {
		const ws = this.ws;
		if (!ws || ws.readyState !== NodeWebSocket.OPEN) {
			return Promise.reject(new Error("Gateway WebSocket is not connected"));
		}

		return new Promise<GatewayResFrame>((resolve, reject) => {
			const id = randomUUID();
			const frame: GatewayReqFrame = { type: "req", id, method, params };
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Gateway request timed out (${method})`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			ws.send(JSON.stringify(frame));
		});
	}

	close(code?: number, reason?: string): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.flushPending(new Error("Gateway connection closed"));
		try {
			this.ws?.close(code, reason);
		} catch {
			// Ignore socket close failures.
		}
	}

	private flushPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private handleMessageText(text: string): void {
		let frame: GatewayFrame | null = null;
		try {
			frame = JSON.parse(text) as GatewayFrame;
		} catch {
			return;
		}
		if (!frame || typeof frame !== "object" || !("type" in frame)) {
			return;
		}

		if (frame.type === "res") {
			const response = frame as GatewayResFrame;
			const pending = this.pending.get(response.id);
			if (!pending) {
				return;
			}
			this.pending.delete(response.id);
			clearTimeout(pending.timeout);
			pending.resolve(response);
			return;
		}

		if (frame.type === "event") {
			const evt = frame as GatewayEventFrame;
			if (evt.event === "connect.challenge") {
				const payload = asRecord(evt.payload);
				const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : null;
				if (nonce) {
					this.challengeNonce = nonce;
					this.challengeResolve?.(nonce);
					this.challengeResolve = null;
				}
				return;
			}
			this.onEvent(evt);
		}
	}
}

async function openGatewayClient(
	onEvent: (frame: GatewayEventFrame) => void,
	onClose: (code: number, reason: string) => void,
): Promise<{ client: GatewayWsClient; settings: GatewayConnectionSettings }> {
	const candidates = resolveGatewayConnectionCandidates();
	let lastError: Error | null = null;
	for (const settings of candidates) {
		const client = new GatewayWsClient(settings, onEvent, onClose);
		try {
			await client.open();
			return { client, settings };
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));
			client.close();
		}
	}
	throw lastError ?? new Error("Gateway WebSocket connection failed");
}

class GatewayProcessHandle
	extends EventEmitter
	implements AgentProcessHandle
{
	public readonly stdout: NodeJS.ReadableStream | null = new PassThrough();
	public readonly stderr: NodeJS.ReadableStream | null = new PassThrough();
	private client: GatewayWsClient | null = null;
	private finished = false;
	private closeScheduled = false;
	private requestedClose = false;
	private runId: string | null = null;
	private lifecycleErrorCloseTimer: ReturnType<typeof setTimeout> | null = null;
	private lifecycleErrorRecoveryUntil = 0;
	private useChatSend = false;
	private receivedAgentEvent = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private lastGlobalSeq = 0;
	private replayFloorSeq = 0;
	private sessionStarted = false;
	private readonly startIdempotencyKey = randomUUID();

	constructor(private readonly params: SpawnGatewayProcessParams) {
		super();
		const initialSeq = Math.max(
			0,
			Number.isFinite(params.afterSeq) ? params.afterSeq : 0,
		);
		this.lastGlobalSeq = initialSeq;
		this.replayFloorSeq = initialSeq;
		void this.start();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		if (this.finished) {
			return false;
		}
		this.requestedClose = true;
		this.clearReconnectTimer();
		this.clearLifecycleErrorCloseTimer();
		this.client?.close();
		const closeSignal = typeof signal === "string" ? signal : null;
		this.finish(0, closeSignal);
		return true;
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) {
			return;
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private resetReconnectState(): void {
		this.reconnectAttempt = 0;
		this.clearReconnectTimer();
	}

	private retryMode(): "start" | "subscribe" | "resume" {
		if (this.params.mode === "start") {
			return this.sessionStarted && Boolean(this.params.sessionKey) ? "resume" : "start";
		}
		return this.sessionStarted ? "resume" : "subscribe";
	}

	private shouldScheduleReconnect(detail: string, code?: number): boolean {
		if (this.finished || this.requestedClose || this.closeScheduled) {
			return false;
		}
		if (typeof code === "number" && !isRetryableGatewayCloseCode(code)) {
			return false;
		}
		if (!isRetryableGatewayTransportError(detail)) {
			return false;
		}
		if (this.reconnectAttempt >= GATEWAY_RECONNECT_MAX_ATTEMPTS) {
			return false;
		}
		const mode = this.retryMode();
		if (mode === "resume") {
			return Boolean(this.params.sessionKey);
		}
		if (mode === "subscribe") {
			return Boolean(this.params.sessionKey);
		}
		return typeof this.params.message === "string";
	}

	private scheduleReconnect(detail: string, code?: number): boolean {
		if (!this.shouldScheduleReconnect(detail, code)) {
			return false;
		}
		if (this.reconnectTimer) {
			return true;
		}
		this.clearLifecycleErrorCloseTimer();
		try {
			this.client?.close();
		} catch {
			// Ignore socket close failures while entering reconnect mode.
		}
		this.client = null;
		this.replayFloorSeq = Math.max(this.replayFloorSeq, this.lastGlobalSeq);
		const delay = Math.min(
			GATEWAY_RECONNECT_MAX_MS,
			GATEWAY_RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
		);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.reconnectAfterDrop();
		}, delay);
		return true;
	}

	private async openAndAuthenticate(): Promise<void> {
		const { client, settings } = await openGatewayClient(
			(frame) => this.handleGatewayEvent(frame),
			(code, reason) => this.handleSocketClose(code, reason),
		);
		this.client = client;
		try {
			const stateDir = resolveOpenClawStateDir();
			const deviceIdentity = loadDeviceIdentity(stateDir);
			const deviceAuth = loadDeviceAuth(stateDir);

			let nonce: string | undefined;
			if (deviceIdentity) {
				try {
					nonce = await client.waitForChallenge();
				} catch {
					nonce = undefined;
				}
			}

			const connectParams = buildConnectParams(settings, {
				nonce,
				deviceIdentity,
				deviceToken: deviceAuth?.token,
			});
			const connectRes = await client.request("connect", connectParams);
			if (!connectRes.ok) {
				throw new Error(frameErrorMessage(connectRes));
			}
		} catch (error) {
			this.client = null;
			client.close();
			throw error;
		}
	}

	private async beginStartMode(): Promise<void> {
		const client = this.client;
		if (!client) {
			throw new Error("Gateway WebSocket is not connected");
		}
		if (this.params.sessionKey) {
			// Pre-patch verbose for existing sessions (best-effort; new
			// sessions don't exist yet so this may fail — we retry below).
			await this.ensureFullToolVerbose(
				this.params.sessionKey,
				this.params.modelOverride,
			);
		}

		const sessionKey = this.params.sessionKey;
		const msg = this.params.message ?? "";
		const normalizedModelOverride = normalizeModelOverride(
			this.params.modelOverride,
		);
		// Always use chat.send so runs are registered in the gateway's
		// session-level tracking.  The `agent` RPC scopes runs to the
		// originating WebSocket, making them invisible to chat.abort
		// from any other connection (including the stop route).
		this.useChatSend = true;

		let startRes: GatewayResFrame;
		if (this.useChatSend) {
			startRes = await client.request("chat.send", {
				message: msg,
				...(sessionKey ? { sessionKey } : {}),
				idempotencyKey: this.startIdempotencyKey,
				deliver: false,
			});
		} else {
			startRes = await client.request("agent", {
				message: msg,
				idempotencyKey: this.startIdempotencyKey,
				...(sessionKey ? { sessionKey } : {}),
				deliver: false,
				channel: "webchat",
				lane: this.params.lane ?? "web",
				timeout: 0,
			});
		}
		if (!startRes.ok) {
			throw new Error(frameErrorMessage(startRes));
		}
		const payload = asRecord(startRes.payload);
		const runId =
			payload && typeof payload.runId === "string" ? payload.runId : null;
		this.runId = runId;
		this.sessionStarted = true;

		// Retry verbose patch now that the RPC has created the
		// session.  This is the critical path for first-message-in-chat
		// where the pre-patch above failed.
		if (sessionKey) {
			await this.ensureFullToolVerbose(sessionKey, this.params.modelOverride);
		}
	}

	private async beginSubscribeMode(afterSeq: number): Promise<void> {
		const client = this.client;
		const sessionKey = this.params.sessionKey;
		if (!client) {
			throw new Error("Gateway WebSocket is not connected");
		}
		if (!sessionKey) {
			throw new Error("Missing session key for subscribe mode");
		}
		const effectiveAfterSeq = Math.max(
			0,
			Number.isFinite(afterSeq) ? afterSeq : 0,
		);
		this.replayFloorSeq = effectiveAfterSeq;
		await this.ensureFullToolVerbose(sessionKey);
		if (cachedAgentSubscribeSupport !== "unsupported") {
			const subscribeRes = await client.request("agent.subscribe", {
				sessionKey,
				afterSeq: effectiveAfterSeq,
			});
			if (!subscribeRes.ok) {
				if (isUnknownMethodResponse(subscribeRes, "agent.subscribe")) {
					cachedAgentSubscribeSupport = "unsupported";
					(this.stderr as PassThrough).write(
						"[gateway] agent.subscribe unavailable; using passive session filter mode\n",
					);
				} else {
					throw new Error(frameErrorMessage(subscribeRes));
				}
			} else {
				cachedAgentSubscribeSupport = "supported";
			}
		}
		this.sessionStarted = true;
	}

	private async reconnectAfterDrop(): Promise<void> {
		if (this.finished || this.requestedClose) {
			return;
		}
		try {
			await this.openAndAuthenticate();
			const mode = this.retryMode();
			if (mode === "start") {
				await this.beginStartMode();
			} else {
				await this.beginSubscribeMode(this.replayFloorSeq);
			}
			this.resetReconnectState();
		} catch (error) {
			const raw =
				error instanceof Error ? error.message : String(error);
			if (this.scheduleReconnect(raw)) {
				return;
			}
			const enhanced = enhanceScopeError(raw);
			const err = new Error(enhanced ?? raw);
			(this.stderr as PassThrough).write(`${err.message}\n`);
			this.emit("error", err);
			this.finish(1, null);
		}
	}

	private async start(): Promise<void> {
		try {
			await this.openAndAuthenticate();
			if (this.params.mode === "start") {
				await this.beginStartMode();
			} else {
				await this.beginSubscribeMode(this.params.afterSeq);
			}
			this.resetReconnectState();
		} catch (error) {
			const raw =
				error instanceof Error ? error.message : String(error);
			if (this.scheduleReconnect(raw)) {
				return;
			}
			const enhanced = enhanceScopeError(raw);
			const err = new Error(enhanced ?? raw);
			(this.stderr as PassThrough).write(`${err.message}\n`);
			this.emit("error", err);
			this.finish(1, null);
		}
	}

	private async ensureFullToolVerbose(
		sessionKey: string,
		modelOverride?: string,
	): Promise<void> {
		if (!this.client || !sessionKey.trim()) {
			return;
		}

		const patchParams: Record<string, string> = {
			key: sessionKey,
			thinkingLevel: "high",
			verboseLevel: "full",
			reasoningLevel: "on",
		};
		const normalizedModelOverride = normalizeModelOverride(modelOverride);
		if (normalizedModelOverride) {
			patchParams.model = normalizedModelOverride;
		}

		let attempt = 0;
		let lastMessage = "";
		while (attempt < SESSIONS_PATCH_MAX_ATTEMPTS) {
			attempt += 1;
			try {
				const patch = await this.client.request("sessions.patch", patchParams);
				if (patch.ok) {
					return;
				}
				lastMessage = frameErrorMessage(patch);

				// If the error indicates thinkingLevel is unsupported for the
				// current model, retry without it rather than failing entirely.
				if (lastMessage.includes("thinkingLevel") && patchParams.thinkingLevel) {
					delete patchParams.thinkingLevel;
					attempt = 0;
					continue;
				}

				if (
					attempt >= SESSIONS_PATCH_MAX_ATTEMPTS ||
					!isRetryableGatewayMessage(lastMessage)
				) {
					break;
				}
			} catch (error) {
				lastMessage =
					error instanceof Error ? error.message : String(error);

				if (lastMessage.includes("thinkingLevel") && patchParams.thinkingLevel) {
					delete patchParams.thinkingLevel;
					attempt = 0;
					continue;
				}

				if (
					attempt >= SESSIONS_PATCH_MAX_ATTEMPTS ||
					!isRetryableGatewayMessage(lastMessage)
				) {
					break;
				}
			}
			await new Promise((resolve) =>
				setTimeout(resolve, SESSIONS_PATCH_RETRY_DELAY_MS),
			);
		}
		if (lastMessage.trim()) {
			(this.stderr as PassThrough).write(
				`[gateway] sessions.patch verboseLevel=full failed: ${lastMessage}\n`,
			);
		}
	}

	private shouldAcceptSessionEvent(sessionKey: string | undefined): boolean {
		const expected = this.params.sessionKey;
		if (!expected) {
			return true;
		}
		if (this.params.mode === "subscribe") {
			// Subscribe mode should only accept explicit events for the target session.
			return sessionKey === expected;
		}
		if (!sessionKey) {
			return true;
		}
		return sessionKey === expected;
	}

	private handleGatewayEvent(frame: GatewayEventFrame): void {
		if (this.finished) {
			return;
		}
		if (frame.event === "connect.challenge") {
			return;
		}

		if (frame.event === "agent") {
			this.receivedAgentEvent = true;
			const payload = asRecord(frame.payload);
			if (!payload) {
				return;
			}
			const sessionKey =
				typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
			if (!this.shouldAcceptSessionEvent(sessionKey)) {
				return;
			}
			const runId = typeof payload.runId === "string" ? payload.runId : undefined;
			if (this.runId && runId && runId !== this.runId) {
				if (Date.now() <= this.lifecycleErrorRecoveryUntil) {
					// The gateway can recover from lifecycle/error by creating
					// a continuation run with a new runId under the same session.
					// During the recovery window, follow that new run so the UI
					// doesn't miss trailing events before final termination.
					this.runId = runId;
					this.clearLifecycleErrorCloseTimer();
				} else {
					return;
				}
			}
			const payloadGlobalSeq =
				typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
			const eventGlobalSeq =
				payloadGlobalSeq ??
				(typeof frame.seq === "number" ? frame.seq : undefined);
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq <= this.replayFloorSeq
			) {
				return;
			}
			this.sessionStarted = true;
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq > this.lastGlobalSeq
			) {
				this.lastGlobalSeq = eventGlobalSeq;
			}

			const event: AgentEvent = {
				event: "agent",
				...(runId ? { runId } : {}),
				...(typeof payload.stream === "string" ? { stream: payload.stream } : {}),
				...(asRecord(payload.data) ? { data: payload.data as Record<string, unknown> } : {}),
				...(typeof payload.seq === "number" ? { seq: payload.seq } : {}),
				...(typeof eventGlobalSeq === "number"
					? { globalSeq: eventGlobalSeq }
					: {}),
				...(typeof payload.ts === "number" ? { ts: payload.ts } : {}),
				...(sessionKey ? { sessionKey } : {}),
			};

			(this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);

			const stream = typeof payload.stream === "string" ? payload.stream : "";
			const data = asRecord(payload.data);
			const phase = data && typeof data.phase === "string" ? data.phase : "";
			if (
				this.params.mode === "start" &&
				this.params.sessionKey?.includes(":web:") &&
				stream === "tool" &&
				phase === "result" &&
				typeof data?.name === "string" &&
				data.name === "sessions_yield" &&
				sessionKey === this.params.sessionKey
			) {
				this.scheduleClose();
			}
			if (!(stream === "lifecycle" && phase === "error")) {
				this.clearLifecycleErrorCloseTimer();
			}
			if (
				this.params.mode === "start" &&
				stream === "lifecycle" &&
				phase === "end"
			) {
				this.scheduleClose();
			}
			if (
				this.params.mode === "start" &&
				stream === "lifecycle" &&
				phase === "error"
			) {
				this.armLifecycleErrorCloseTimer();
			}
			return;
		}

		if (frame.event === "chat") {
			const payload = asRecord(frame.payload) ?? {};
			const sessionKey =
				typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
			// Forward chat frames in subscribe mode unconditionally.
			// In start mode, only forward when using chat.send for
			// slash commands — the gateway returns command responses
			// as chat events rather than agent events.  Skip if we
			// already received agent events (agent run started) to
			// avoid duplicating the assistant text.
			const forwardChat =
				this.params.mode === "subscribe" ||
				(this.useChatSend && !this.receivedAgentEvent);
			if (!forwardChat) {
				return;
			}
			if (!this.shouldAcceptSessionEvent(sessionKey)) {
				return;
			}
			const payloadGlobalSeq =
				typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
			const eventGlobalSeq =
				payloadGlobalSeq ??
				(typeof frame.seq === "number" ? frame.seq : undefined);
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq <= this.replayFloorSeq
			) {
				return;
			}
			this.sessionStarted = true;
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq > this.lastGlobalSeq
			) {
				this.lastGlobalSeq = eventGlobalSeq;
			}
			const event: AgentEvent = {
				event: "chat",
				data: payload,
				...(typeof eventGlobalSeq === "number"
					? { globalSeq: eventGlobalSeq }
					: {}),
				...(sessionKey ? { sessionKey } : {}),
			};
			(this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);

			if (
				this.useChatSend &&
				this.params.mode === "start" &&
				typeof payload.state === "string" &&
				payload.state === "final"
			) {
				this.scheduleClose();
			}
			return;
		}

		if (frame.event === "error") {
			const payload = asRecord(frame.payload) ?? {};
			const sessionKey =
				typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
			if (!this.shouldAcceptSessionEvent(sessionKey)) {
				return;
			}
			const payloadGlobalSeq =
				typeof payload.globalSeq === "number" ? payload.globalSeq : undefined;
			const eventGlobalSeq =
				payloadGlobalSeq ??
				(typeof frame.seq === "number" ? frame.seq : undefined);
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq <= this.replayFloorSeq
			) {
				return;
			}
			this.sessionStarted = true;
			if (
				typeof eventGlobalSeq === "number" &&
				eventGlobalSeq > this.lastGlobalSeq
			) {
				this.lastGlobalSeq = eventGlobalSeq;
			}
			const event: AgentEvent = {
				event: "error",
				data: payload,
				...(typeof eventGlobalSeq === "number"
					? { globalSeq: eventGlobalSeq }
					: {}),
				...(sessionKey ? { sessionKey } : {}),
			};
			(this.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
			if (this.params.mode === "start") {
				this.armLifecycleErrorCloseTimer();
			}
		}
	}

	private armLifecycleErrorCloseTimer(): void {
		this.lifecycleErrorRecoveryUntil = Date.now() + LIFECYCLE_ERROR_RECOVERY_MS;
		this.clearLifecycleErrorCloseTimer();
		this.lifecycleErrorCloseTimer = setTimeout(() => {
			this.lifecycleErrorCloseTimer = null;
			if (this.finished) {
				return;
			}
			this.scheduleClose();
		}, LIFECYCLE_ERROR_RECOVERY_MS);
	}

	private clearLifecycleErrorCloseTimer(): void {
		this.lifecycleErrorRecoveryUntil = 0;
		if (!this.lifecycleErrorCloseTimer) {
			return;
		}
		clearTimeout(this.lifecycleErrorCloseTimer);
		this.lifecycleErrorCloseTimer = null;
	}

	private scheduleClose(): void {
		if (this.closeScheduled || this.finished) {
			return;
		}
		this.closeScheduled = true;
		this.clearReconnectTimer();
		setTimeout(() => {
			if (this.finished) {
				return;
			}
			this.requestedClose = true;
			this.client?.close();
			this.finish(0, null);
		}, 25);
	}

	private handleSocketClose(code: number, reason: string): void {
		if (this.finished) {
			return;
		}
		this.client = null;
		if (this.closeScheduled) {
			this.requestedClose = true;
			this.finish(0, null);
			return;
		}
		const detail = reason.trim() || `code ${code}`;
		if (this.scheduleReconnect(detail, code)) {
			return;
		}
		if (!this.requestedClose) {
			(this.stderr as PassThrough).write(`Gateway connection closed: ${detail}\n`);
		}
		const exitCode = this.requestedClose ? 0 : 1;
		this.finish(exitCode, null);
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.clearReconnectTimer();
		this.clearLifecycleErrorCloseTimer();
		this.client = null;
		try {
			(this.stdout as PassThrough).end();
			(this.stderr as PassThrough).end();
		} catch {
			// Ignore stream close errors.
		}
		this.emit("close", code, signal);
	}
}

async function callGatewayRpcOnce(
	method: string,
	params?: Record<string, unknown>,
	options?: { timeoutMs?: number },
): Promise<GatewayResFrame> {
	let closed = false;
	const { client, settings } = await openGatewayClient(
		() => {},
		() => {
			closed = true;
		},
	);
	try {
		const stateDir = resolveOpenClawStateDir();
		const deviceIdentity = loadDeviceIdentity(stateDir);
		const deviceAuth = loadDeviceAuth(stateDir);

		let nonce: string | undefined;
		if (deviceIdentity) {
			try {
				nonce = await client.waitForChallenge();
			} catch {
				nonce = undefined;
			}
		}

		const connect = await client.request(
			"connect",
			buildConnectParams(settings, {
				nonce,
				deviceIdentity,
				deviceToken: deviceAuth?.token,
			}),
			options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
		);
		if (!connect.ok) {
			throw new Error(frameErrorMessage(connect));
		}
		const result = await client.request(
			method,
			params,
			options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
		);
		return result;
	} finally {
		if (!closed) {
			client.close();
		}
	}
}

export async function callGatewayRpc(
	method: string,
	params?: Record<string, unknown>,
	options?: { timeoutMs?: number; retries?: number },
): Promise<GatewayResFrame> {
	const retries = Math.max(
		0,
		Number.isFinite(options?.retries) ? Number(options?.retries) : 2,
	);
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try {
			return await callGatewayRpcOnce(method, params, options);
		} catch (error) {
			lastError = error;
			const raw = error instanceof Error ? error.message : String(error);
			if (attempt >= retries || !isRetryableGatewayTransportError(raw)) {
				throw error;
			}
			const delay = Math.min(
				2_000,
				GATEWAY_RPC_RETRY_BASE_MS * 2 ** attempt,
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(lastError == null ? "Gateway RPC failed" : String(lastError));
}

/**
 * Start an agent run via the Gateway WebSocket and return a process handle.
 * @param overrideAgentId - Use a specific agent ID instead of the workspace default.
 */
export function spawnAgentProcess(
	message: string,
	agentSessionId?: string,
	overrideAgentId?: string,
	modelOverride?: string,
): AgentProcessHandle {
	const agentId = overrideAgentId ?? resolveActiveAgentId();
	const sessionKey = agentSessionId
		? `agent:${agentId}:web:${agentSessionId}`
		: undefined;
	return new GatewayProcessHandle({
		mode: "start",
		message,
		sessionKey,
		afterSeq: 0,
		lane: agentSessionId ? `web:${agentSessionId}` : "web",
		modelOverride,
	});
}

/**
 * Spawn a subscribe-only agent child process that tails a session key's events.
 * Uses the same runtime/env wiring as spawnAgentProcess.
 */
export function spawnAgentSubscribeProcess(
	sessionKey: string,
	afterSeq = 0,
): AgentProcessHandle {
	return new GatewayProcessHandle({
		mode: "subscribe",
		sessionKey,
		afterSeq: Math.max(0, Number.isFinite(afterSeq) ? afterSeq : 0),
	});
}

/**
 * Spawn a start-mode agent process for a subagent follow-up message.
 * Uses the `agent` RPC which receives ALL events (including tool events)
 * on the same WebSocket connection, unlike passive subscribe mode.
 */
export function spawnAgentStartForSession(
	message: string,
	sessionKey: string,
): AgentProcessHandle {
	return new GatewayProcessHandle({
		mode: "start",
		message,
		sessionKey,
		afterSeq: 0,
		lane: "subagent",
	});
}

/**
 * Build a flat output object from the agent's tool result so the frontend
 * can render tool output text, exit codes, etc.
 *
 * Passes through ALL details fields — no whitelist filtering so the UI gets
 * the full picture (exit codes, file paths, search results, diffs, etc.).
 */
export function buildToolOutput(
	result?: ToolResult,
): Record<string, unknown> {
	if (!result) {return {};}
	const out: Record<string, unknown> = {};
	if (result.text) {out.text = result.text;}
	if (result.details) {
		// Pass through all details keys — don't filter so nothing is lost
		for (const [key, value] of Object.entries(result.details)) {
			if (value !== undefined) {out[key] = value;}
		}
	}
	// If we have details but no text, synthesize a text field from the JSON so
	// domain-extraction regex in the frontend can find URLs from search results.
	if (!out.text && result.details) {
		try {
			const json = JSON.stringify(result.details);
			if (json.length <= 50_000) {
				out.text = json;
			}
		} catch {
			/* ignore */
		}
	}
	return out;
}

// ── Error message extraction helpers ──

/**
 * Extract a user-friendly error message from an agent event's data object.
 * Handles various shapes: `{ error: "..." }`, `{ message: "..." }`,
 * `{ errorMessage: "402 {...}" }`, etc.
 */
export function parseAgentErrorMessage(
	data: Record<string, unknown> | undefined,
): string | undefined {
	if (!data) {return undefined;}

	// Direct error string
	if (typeof data.error === "string") {return parseErrorBody(data.error);}
	// Nested error object with message
	if (typeof data.error === "object" && data.error !== null) {
		const nested = data.error as Record<string, unknown>;
		if (typeof nested.message === "string") {return parseErrorBody(nested.message);}
	}
	// Message field
	if (typeof data.message === "string") {return parseErrorBody(data.message);}
	// errorMessage field (may contain "402 {json}")
	if (typeof data.errorMessage === "string")
		{return parseErrorBody(data.errorMessage);}
	// Common alternative fields
	if (typeof data.detail === "string") {return parseErrorBody(data.detail);}
	if (typeof data.reason === "string") {return parseErrorBody(data.reason);}
	if (typeof data.description === "string") {return parseErrorBody(data.description);}
	// Error code as last-resort hint
	if (typeof data.code === "string" && data.code.trim()) {return data.code;}

	// Fallback: serialize the entire payload so the error is never silently lost
	try {
		const json = JSON.stringify(data);
		if (json !== "{}" && json.length <= 500) {return json;}
		if (json.length > 500) {return `${json.slice(0, 497)}...`;}
	} catch { /* ignore */ }

	return undefined;
}

/**
 * Parse a raw error string that may contain an HTTP status + JSON body,
 * e.g. `402 {"error":{"message":"Insufficient funds..."}}`.
 * Returns a clean, user-readable message.
 */
export function parseErrorBody(raw: string): string {
	if (raw === "terminated") {
		return "Agent run was terminated by the gateway. This is usually caused by the model provider dropping the connection mid-stream. Retry the message to continue.";
	}

	// Try to extract JSON body from "STATUS {json}" pattern
	const jsonIdx = raw.indexOf("{");
	if (jsonIdx >= 0) {
		try {
			const parsed = JSON.parse(raw.slice(jsonIdx));
			const msg =
				parsed?.error?.message ?? parsed?.message ?? parsed?.error;
			if (typeof msg === "string") {return msg;}
		} catch {
			// not valid JSON, fall through
		}
	}
	return raw;
}

/**
 * Extract a meaningful error message from raw stderr output.
 * Strips ANSI codes and looks for common error patterns.
 */
export function parseErrorFromStderr(stderr: string): string | undefined {
	if (!stderr) {return undefined;}

	// Strip ANSI escape codes
	// eslint-disable-next-line no-control-regex
	const clean = stderr.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

	// Look for JSON error bodies (e.g. from API responses)
	const jsonMatch = clean.match(/\{"error":\{[^}]*"message":"([^"]+)"[^}]*\}/);
	if (jsonMatch?.[1]) {return jsonMatch[1];}

	// Look for lines containing "error" (case-insensitive)
	const lines = clean.split("\n").filter(Boolean);
	for (const line of lines) {
		const trimmed = line.trim();
		if (/\b(error|failed|fatal)\b/i.test(trimmed)) {
			// Strip common prefixes like "[openclaw]", timestamps, etc.
			const stripped = trimmed
				.replace(/^\[.*?\]\s*/, "")
				.replace(/^Error:\s*/i, "");
			if (stripped.length > 5) {return stripped;}
		}
	}

	// Last resort: return last non-empty line if it's short enough
	const last = lines[lines.length - 1]?.trim();
	if (last && last.length <= 300) {return last;}

	return undefined;
}
