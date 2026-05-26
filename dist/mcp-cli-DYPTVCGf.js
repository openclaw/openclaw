import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { At as boolean, Rn as string, Tn as object, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { r as extractFirstTextBlock } from "./chat-message-content-DN9xEd6w.js";
import { i as parseConfigValue, n as setConfiguredMcpServer, r as unsetConfiguredMcpServer, t as listConfiguredMcpServers } from "./mcp-config-BDsyH-NL.js";
import { t as resolveGatewayAuthOptions } from "./gateway-secret-options-D9e0ZqVQ.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-DQUF3qKA.js";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
//#region src/mcp/channel-shared.ts
const ClaudePermissionRequestSchema = object({
	method: literal("notifications/claude/channel/permission_request"),
	params: object({
		request_id: string(),
		tool_name: string(),
		description: string(),
		input_preview: string()
	})
});
function resolveMessageId(entry) {
	return normalizeOptionalString(entry.id) ?? (entry["__openclaw"] && typeof entry["__openclaw"] === "object" ? normalizeOptionalString(entry["__openclaw"].id) : void 0);
}
function summarizeResult(label, count) {
	return { content: [{
		type: "text",
		text: `${label}: ${count}`
	}] };
}
function summarizeStructuredResult(label, count, payload) {
	return { content: [{
		type: "text",
		text: `${label}: ${count}\n\n${JSON.stringify(payload, null, 2)}`
	}] };
}
function resolveConversationChannel(row) {
	return normalizeOptionalLowercaseString(normalizeOptionalString(row.deliveryContext?.channel) ?? normalizeOptionalString(row.lastChannel) ?? normalizeOptionalString(row.channel) ?? normalizeOptionalString(row.origin?.provider));
}
function toConversation(row) {
	const channel = resolveConversationChannel(row);
	const to = normalizeOptionalString(row.deliveryContext?.to) ?? normalizeOptionalString(row.lastTo);
	if (!channel || !to) return null;
	return {
		sessionKey: row.key,
		channel,
		to,
		accountId: normalizeOptionalString(row.deliveryContext?.accountId) ?? normalizeOptionalString(row.lastAccountId) ?? normalizeOptionalString(row.origin?.accountId),
		threadId: row.deliveryContext?.threadId ?? row.lastThreadId ?? row.origin?.threadId,
		label: normalizeOptionalString(row.label),
		displayName: normalizeOptionalString(row.displayName),
		derivedTitle: normalizeOptionalString(row.derivedTitle),
		lastMessagePreview: normalizeOptionalString(row.lastMessagePreview),
		updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null
	};
}
function matchEventFilter(event, filter) {
	if (event.cursor <= filter.afterCursor) return false;
	if (!filter.sessionKey) return true;
	return "sessionKey" in event && event.sessionKey === filter.sessionKey;
}
function extractAttachmentsFromMessage(message) {
	if (!message || typeof message !== "object") return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];
	return content.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		return normalizeOptionalString(entry.type) !== "text";
	});
}
function normalizeApprovalId(value) {
	const id = normalizeOptionalString(value);
	return id ? id.trim() : void 0;
}
//#endregion
//#region src/mcp/channel-bridge.ts
const CLAUDE_PERMISSION_REPLY_RE = /^(yes|no)\s+([a-km-z]{5})$/i;
const QUEUE_LIMIT = 1e3;
var OpenClawChannelBridge = class {
	constructor(cfg, params) {
		this.cfg = cfg;
		this.params = params;
		this.gateway = null;
		this.queue = [];
		this.pendingWaiters = /* @__PURE__ */ new Set();
		this.pendingClaudePermissions = /* @__PURE__ */ new Map();
		this.pendingApprovals = /* @__PURE__ */ new Map();
		this.server = null;
		this.cursor = 0;
		this.closed = false;
		this.ready = false;
		this.started = false;
		this.retryingInitialConnect = false;
		this.readySettled = false;
		this.verbose = params.verbose;
		this.claudeChannelMode = params.claudeChannelMode;
		this.readyPromise = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
	}
	setServer(server) {
		this.server = server;
	}
	async start() {
		if (this.started) {
			await this.readyPromise;
			return;
		}
		this.started = true;
		const [{ resolveGatewayClientBootstrap }, { GatewayClient: GatewayClientCtor }, { startGatewayClientWhenEventLoopReady }, { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE }, { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES }] = await Promise.all([
			import("./client-bootstrap-C-WMk3k-.js"),
			import("./client-9y48GCMh.js"),
			import("./client-start-readiness-BhWQ3Lv7.js"),
			import("./method-scopes-DcP6sJ3C.js"),
			import("./client-info-RVHFt8yy.js")
		]);
		const bootstrap = await resolveGatewayClientBootstrap({
			config: this.cfg,
			gatewayUrl: this.params.gatewayUrl,
			explicitAuth: {
				token: this.params.gatewayToken,
				password: this.params.gatewayPassword
			},
			env: process.env
		});
		if (this.closed) {
			this.resolveReadyOnce();
			return;
		}
		this.gateway = new GatewayClientCtor({
			url: bootstrap.url,
			token: bootstrap.auth.token,
			password: bootstrap.auth.password,
			preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			clientDisplayName: "OpenClaw MCP",
			clientVersion: VERSION,
			mode: GATEWAY_CLIENT_MODES.CLI,
			scopes: [
				READ_SCOPE,
				WRITE_SCOPE,
				APPROVALS_SCOPE
			],
			requestTimeoutMs: 18e4,
			onEvent: (event) => {
				this.handleGatewayEvent(event);
			},
			onHelloOk: () => {
				this.retryingInitialConnect = false;
				this.handleHelloOk();
			},
			onConnectError: (error) => {
				const normalizedError = error instanceof Error ? error : new Error(String(error));
				if (shouldRetryInitialMcpGatewayConnect(normalizedError)) {
					this.retryingInitialConnect = true;
					return;
				}
				this.rejectReadyOnce(normalizedError);
			},
			onClose: (code, reason) => {
				if (!this.ready && !this.closed && !this.retryingInitialConnect) this.rejectReadyOnce(/* @__PURE__ */ new Error(`gateway closed before ready (${code}): ${reason}`));
				this.retryingInitialConnect = false;
			}
		});
		if (!(await startGatewayClientWhenEventLoopReady(this.gateway, { clientOptions: { preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs } })).ready) this.rejectReadyOnce(/* @__PURE__ */ new Error("gateway event loop readiness timeout"));
		await this.readyPromise;
	}
	async waitUntilReady() {
		await this.readyPromise;
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		this.resolveReadyOnce();
		for (const waiter of this.pendingWaiters) {
			if (waiter.timeout) clearTimeout(waiter.timeout);
			waiter.resolve(null);
		}
		this.pendingWaiters.clear();
		const gateway = this.gateway;
		this.gateway = null;
		await gateway?.stopAndWait().catch(() => void 0);
	}
	async listConversations(params) {
		await this.waitUntilReady();
		const response = await this.requestGateway("sessions.list", {
			limit: params?.limit ?? 50,
			search: params?.search,
			includeDerivedTitles: params?.includeDerivedTitles ?? true,
			includeLastMessage: params?.includeLastMessage ?? true
		});
		const requestedChannel = normalizeOptionalLowercaseString(params?.channel);
		return (response.sessions ?? []).map(toConversation).filter((conversation) => Boolean(conversation)).filter((conversation) => requestedChannel ? normalizeLowercaseStringOrEmpty(conversation.channel) === requestedChannel : true);
	}
	async getConversation(sessionKey) {
		const normalizedSessionKey = sessionKey.trim();
		if (!normalizedSessionKey) return null;
		await this.waitUntilReady();
		const response = await this.requestGateway("sessions.describe", {
			key: normalizedSessionKey,
			includeDerivedTitles: true,
			includeLastMessage: true
		});
		return response.session ? toConversation(response.session) : null;
	}
	async readMessages(sessionKey, limit = 20) {
		await this.waitUntilReady();
		return (await this.requestGateway("sessions.get", {
			key: sessionKey,
			limit
		})).messages ?? [];
	}
	async sendMessage(params) {
		const conversation = await this.getConversation(params.sessionKey);
		if (!conversation) throw new Error(`Conversation not found for session ${params.sessionKey}`);
		return await this.requestGateway("send", {
			to: conversation.to,
			channel: conversation.channel,
			accountId: conversation.accountId,
			threadId: conversation.threadId == null ? void 0 : String(conversation.threadId),
			message: params.text,
			sessionKey: conversation.sessionKey,
			idempotencyKey: randomUUID()
		});
	}
	listPendingApprovals() {
		return [...this.pendingApprovals.values()].toSorted((a, b) => {
			return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
		});
	}
	async respondToApproval(params) {
		if (params.kind === "exec") return await this.requestGateway("exec.approval.resolve", {
			id: params.id,
			decision: params.decision
		});
		return await this.requestGateway("plugin.approval.resolve", {
			id: params.id,
			decision: params.decision
		});
	}
	pollEvents(filter, limit = 20) {
		const events = this.queue.filter((event) => matchEventFilter(event, filter)).slice(0, limit);
		return {
			events,
			nextCursor: events.at(-1)?.cursor ?? filter.afterCursor
		};
	}
	async waitForEvent(filter, timeoutMs = 3e4) {
		const existing = this.queue.find((event) => matchEventFilter(event, filter));
		if (existing) return existing;
		return await new Promise((resolve) => {
			const waiter = {
				filter,
				resolve: (value) => {
					this.pendingWaiters.delete(waiter);
					resolve(value);
				},
				timeout: null
			};
			if (timeoutMs > 0) waiter.timeout = setTimeout(() => {
				waiter.resolve(null);
			}, timeoutMs);
			this.pendingWaiters.add(waiter);
		});
	}
	async handleClaudePermissionRequest(params) {
		this.pendingClaudePermissions.set(params.requestId, {
			toolName: params.toolName,
			description: params.description,
			inputPreview: params.inputPreview
		});
		this.enqueue({
			cursor: this.nextCursor(),
			type: "claude_permission_request",
			requestId: params.requestId,
			toolName: params.toolName,
			description: params.description,
			inputPreview: params.inputPreview
		});
		if (this.verbose) process.stderr.write(`openclaw mcp: pending Claude permission ${params.requestId}\n`);
	}
	async requestGateway(method, params) {
		if (!this.gateway) throw new Error("Gateway client is not ready");
		return await this.gateway.request(method, params);
	}
	async sendNotification(notification) {
		if (!this.server || this.closed) return;
		try {
			await this.server.server.notification(notification);
		} catch (error) {
			if (this.verbose && !this.closed) process.stderr.write(`openclaw mcp: notification ${notification.method} failed: ${String(error)}\n`);
		}
	}
	async handleHelloOk() {
		try {
			await this.requestGateway("sessions.subscribe", {});
			this.ready = true;
			this.resolveReadyOnce();
		} catch (error) {
			this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
		}
	}
	resolveReadyOnce() {
		if (this.readySettled) return;
		this.readySettled = true;
		this.resolveReady();
	}
	rejectReadyOnce(error) {
		if (this.readySettled) return;
		this.readySettled = true;
		this.rejectReady(error);
	}
	nextCursor() {
		this.cursor += 1;
		return this.cursor;
	}
	enqueue(event) {
		this.queue.push(event);
		while (this.queue.length > QUEUE_LIMIT) this.queue.shift();
		for (const waiter of this.pendingWaiters) {
			if (!matchEventFilter(event, waiter.filter)) continue;
			if (waiter.timeout) clearTimeout(waiter.timeout);
			waiter.resolve(event);
		}
	}
	trackApproval(kind, payload) {
		const id = normalizeApprovalId(payload.id);
		if (!id) return;
		this.pendingApprovals.set(id, {
			kind,
			id,
			request: payload.request && typeof payload.request === "object" ? payload.request : void 0,
			createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : void 0,
			expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : void 0
		});
	}
	resolveTrackedApproval(payload) {
		const id = normalizeApprovalId(payload.id);
		if (id) this.pendingApprovals.delete(id);
	}
	async handleGatewayEvent(event) {
		switch (event.event) {
			case "session.message":
				await this.handleSessionMessageEvent(event.payload);
				return;
			case "exec.approval.requested": {
				const raw = event.payload ?? {};
				this.trackApproval("exec", raw);
				this.enqueue({
					cursor: this.nextCursor(),
					type: "exec_approval_requested",
					raw
				});
				return;
			}
			case "exec.approval.resolved": {
				const raw = event.payload ?? {};
				this.resolveTrackedApproval(raw);
				this.enqueue({
					cursor: this.nextCursor(),
					type: "exec_approval_resolved",
					raw
				});
				return;
			}
			case "plugin.approval.requested": {
				const raw = event.payload ?? {};
				this.trackApproval("plugin", raw);
				this.enqueue({
					cursor: this.nextCursor(),
					type: "plugin_approval_requested",
					raw
				});
				return;
			}
			case "plugin.approval.resolved": {
				const raw = event.payload ?? {};
				this.resolveTrackedApproval(raw);
				this.enqueue({
					cursor: this.nextCursor(),
					type: "plugin_approval_resolved",
					raw
				});
			}
		}
	}
	async handleSessionMessageEvent(payload) {
		const sessionKey = normalizeOptionalString(payload.sessionKey);
		if (!sessionKey) return;
		const conversation = toConversation({
			key: sessionKey,
			lastChannel: normalizeOptionalString(payload.lastChannel),
			lastTo: normalizeOptionalString(payload.lastTo),
			lastAccountId: normalizeOptionalString(payload.lastAccountId),
			lastThreadId: payload.lastThreadId
		}) ?? void 0;
		const role = normalizeOptionalString(payload.message?.role);
		const text = extractFirstTextBlock(payload.message);
		const permissionMatch = text ? CLAUDE_PERMISSION_REPLY_RE.exec(text) : null;
		if (permissionMatch) {
			const requestId = normalizeOptionalLowercaseString(permissionMatch[2]);
			if (requestId && this.pendingClaudePermissions.has(requestId)) {
				this.pendingClaudePermissions.delete(requestId);
				await this.sendNotification({
					method: "notifications/claude/channel/permission",
					params: {
						request_id: requestId,
						behavior: normalizeLowercaseStringOrEmpty(permissionMatch[1]).startsWith("y") ? "allow" : "deny"
					}
				});
				return;
			}
		}
		this.enqueue({
			cursor: this.nextCursor(),
			type: "message",
			sessionKey,
			conversation,
			messageId: normalizeOptionalString(payload.messageId),
			messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : void 0,
			role,
			text,
			raw: payload
		});
		if (!this.shouldEmitClaudeChannel(role, conversation)) return;
		await this.sendNotification({
			method: "notifications/claude/channel",
			params: {
				content: text ?? "[non-text message]",
				meta: {
					session_key: sessionKey,
					channel: conversation?.channel ?? "",
					to: conversation?.to ?? "",
					account_id: conversation?.accountId ?? "",
					thread_id: conversation?.threadId == null ? "" : String(conversation.threadId),
					message_id: normalizeOptionalString(payload.messageId) ?? ""
				}
			}
		});
	}
	shouldEmitClaudeChannel(role, conversation) {
		if (this.claudeChannelMode === "off") return false;
		if (role !== "user") return false;
		return Boolean(conversation);
	}
};
function shouldRetryInitialMcpGatewayConnect(error) {
	if (error.name === "GatewayClientRequestError" && "retryable" in error && typeof error.retryable === "boolean") return error.retryable;
	const message = error.message.toLowerCase();
	return message.includes("gateway request timeout for connect") || message.includes("gateway connect challenge timeout");
}
//#endregion
//#region src/mcp/channel-tools.ts
function getChannelMcpCapabilities(claudeChannelMode) {
	if (claudeChannelMode === "off") return;
	return { experimental: {
		"claude/channel": {},
		"claude/channel/permission": {}
	} };
}
function registerChannelMcpTools(server, bridge) {
	server.tool("conversations_list", "List OpenClaw channel-backed conversations available through session routes.", {
		limit: number().int().min(1).max(500).optional(),
		search: string().optional(),
		channel: string().optional(),
		includeDerivedTitles: boolean().optional(),
		includeLastMessage: boolean().optional()
	}, async (args) => {
		const conversations = await bridge.listConversations(args);
		return {
			...summarizeStructuredResult("conversations", conversations.length, { conversations }),
			structuredContent: { conversations }
		};
	});
	server.tool("conversation_get", "Get one OpenClaw conversation by session key.", { session_key: string().min(1) }, async ({ session_key }) => {
		const conversation = await bridge.getConversation(session_key);
		if (!conversation) return {
			content: [{
				type: "text",
				text: `conversation not found: ${session_key}`
			}],
			isError: true
		};
		return {
			content: [{
				type: "text",
				text: `conversation ${conversation.sessionKey}`
			}],
			structuredContent: { conversation }
		};
	});
	server.tool("messages_read", "Read recent messages for one OpenClaw conversation.", {
		session_key: string().min(1),
		limit: number().int().min(1).max(200).optional()
	}, async ({ session_key, limit }) => {
		const messages = await bridge.readMessages(session_key, limit ?? 20);
		return {
			...summarizeStructuredResult("messages", messages.length, { messages }),
			structuredContent: { messages }
		};
	});
	server.tool("attachments_fetch", "List non-text attachments for a message in one OpenClaw conversation.", {
		session_key: string().min(1),
		message_id: string().min(1),
		limit: number().int().min(1).max(200).optional()
	}, async ({ session_key, message_id, limit }) => {
		const message = (await bridge.readMessages(session_key, limit ?? 100)).find((entry) => resolveMessageId(entry) === message_id);
		if (!message) return {
			content: [{
				type: "text",
				text: `message not found: ${message_id}`
			}],
			isError: true
		};
		const attachments = extractAttachmentsFromMessage(message);
		return {
			...summarizeResult("attachments", attachments.length),
			structuredContent: {
				attachments,
				message
			}
		};
	});
	server.tool("events_poll", "Poll queued OpenClaw conversation events since a cursor.", {
		after_cursor: number().int().min(0).optional(),
		session_key: string().optional(),
		limit: number().int().min(1).max(200).optional()
	}, async ({ after_cursor, session_key, limit }) => {
		const { events, nextCursor } = bridge.pollEvents({
			afterCursor: after_cursor ?? 0,
			sessionKey: normalizeOptionalString(session_key)
		}, limit ?? 20);
		return {
			...summarizeResult("events", events.length),
			structuredContent: {
				events,
				next_cursor: nextCursor
			}
		};
	});
	server.tool("events_wait", "Wait for the next queued OpenClaw conversation event.", {
		after_cursor: number().int().min(0).optional(),
		session_key: string().optional(),
		timeout_ms: number().int().min(1).max(3e5).optional()
	}, async ({ after_cursor, session_key, timeout_ms }) => {
		const event = await bridge.waitForEvent({
			afterCursor: after_cursor ?? 0,
			sessionKey: normalizeOptionalString(session_key)
		}, timeout_ms ?? 3e4);
		return {
			content: [{
				type: "text",
				text: event ? `event ${event.cursor}` : "timeout"
			}],
			structuredContent: { event }
		};
	});
	server.tool("messages_send", "Send a message back through the same OpenClaw conversation route.", {
		session_key: string().min(1),
		text: string().min(1)
	}, async ({ session_key, text }) => {
		return {
			content: [{
				type: "text",
				text: "sent"
			}],
			structuredContent: { result: await bridge.sendMessage({
				sessionKey: session_key,
				text
			}) }
		};
	});
	server.tool("permissions_list_open", "List open OpenClaw exec or plugin approval requests visible through the Gateway.", {}, async () => {
		const approvals = bridge.listPendingApprovals();
		return {
			...summarizeResult("approvals", approvals.length),
			structuredContent: { approvals }
		};
	});
	server.tool("permissions_respond", "Allow or deny one pending OpenClaw exec or plugin approval request.", {
		kind: _enum(["exec", "plugin"]),
		id: string().min(1),
		decision: _enum([
			"allow-once",
			"allow-always",
			"deny"
		])
	}, async ({ kind, id, decision }) => {
		return {
			content: [{
				type: "text",
				text: "approval resolved"
			}],
			structuredContent: { result: await bridge.respondToApproval({
				kind,
				id,
				decision
			}) }
		};
	});
}
//#endregion
//#region src/mcp/channel-server.ts
async function resolveMcpConfig(config) {
	if (config) return config;
	const { getRuntimeConfig } = await import("./config/config.js");
	return getRuntimeConfig();
}
async function createOpenClawChannelMcpServer(opts = {}) {
	const cfg = await resolveMcpConfig(opts.config);
	const claudeChannelMode = opts.claudeChannelMode ?? "auto";
	const capabilities = getChannelMcpCapabilities(claudeChannelMode);
	const server = new McpServer({
		name: "openclaw",
		version: VERSION
	}, capabilities ? { capabilities } : void 0);
	const bridge = new OpenClawChannelBridge(cfg, {
		gatewayUrl: opts.gatewayUrl,
		gatewayToken: opts.gatewayToken,
		gatewayPassword: opts.gatewayPassword,
		claudeChannelMode,
		verbose: opts.verbose ?? false
	});
	bridge.setServer(server);
	server.server.setNotificationHandler(ClaudePermissionRequestSchema, async ({ params }) => {
		await bridge.handleClaudePermissionRequest({
			requestId: params.request_id,
			toolName: params.tool_name,
			description: params.description,
			inputPreview: params.input_preview
		});
	});
	registerChannelMcpTools(server, bridge);
	return {
		server,
		bridge,
		start: async () => {
			await bridge.start();
		},
		close: async () => {
			await bridge.close();
			await server.close();
		}
	};
}
async function serveOpenClawChannelMcp(opts = {}) {
	const { server, start, close } = await createOpenClawChannelMcpServer(opts);
	const transport = new StdioServerTransport();
	let shuttingDown = false;
	let resolveClosed;
	const closed = new Promise((resolve) => {
		resolveClosed = resolve;
	});
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		process.stdin.off("end", shutdown);
		process.stdin.off("close", shutdown);
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		transport["onclose"] = void 0;
		close().then(resolveClosed, resolveClosed);
	};
	transport["onclose"] = shutdown;
	process.stdin.once("end", shutdown);
	process.stdin.once("close", shutdown);
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await server.connect(transport);
		await start();
		await closed;
	} finally {
		shutdown();
		await closed;
	}
}
//#endregion
//#region src/cli/mcp-cli.ts
function fail(message) {
	defaultRuntime.error(message);
	defaultRuntime.exit(1);
	throw new Error(message);
}
function printJson(value) {
	defaultRuntime.writeJson(value);
}
function registerMcpCli(program) {
	const mcp = program.command("mcp").description("Manage OpenClaw MCP config and channel bridge");
	mcp.command("serve").description("Expose OpenClaw channels over MCP stdio").option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--token-file <path>", "Read gateway token from file").option("--password <password>", "Gateway password (if required)").option("--password-file <path>", "Read gateway password from file").option("--claude-channel-mode <mode>", "Claude channel notification mode: auto, on, or off", "auto").option("-v, --verbose", "Verbose logging to stderr", false).action(async (opts) => {
		try {
			const { gatewayToken, gatewayPassword } = resolveGatewayAuthOptions(opts);
			const claudeChannelMode = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(opts.claudeChannelMode) ?? "auto");
			if (claudeChannelMode !== "auto" && claudeChannelMode !== "on" && claudeChannelMode !== "off") throw new Error("Invalid --claude-channel-mode value. Use \"auto\", \"on\", or \"off\".");
			await serveOpenClawChannelMcp({
				gatewayUrl: opts.url,
				gatewayToken,
				gatewayPassword,
				claudeChannelMode,
				verbose: Boolean(opts.verbose)
			});
		} catch (err) {
			defaultRuntime.error(`MCP server failed to start: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw mcp list")} to inspect configured servers.`);
			defaultRuntime.exit(1);
		}
	});
	mcp.command("list").description("List configured MCP servers").option("--json", "Print JSON").action(async (opts) => {
		const loaded = await listConfiguredMcpServers();
		if (!loaded.ok) fail(loaded.error);
		if (opts.json) {
			printJson(loaded.mcpServers);
			return;
		}
		const names = Object.keys(loaded.mcpServers).toSorted();
		if (names.length === 0) {
			defaultRuntime.log(`No MCP servers configured in ${loaded.path}. Add one with ${formatCliCommand("openclaw mcp set <name> '{\"command\":\"uvx\",\"args\":[\"context7-mcp\"]}'")}.`);
			return;
		}
		defaultRuntime.log(`MCP servers (${loaded.path}):`);
		for (const name of names) defaultRuntime.log(`- ${name}`);
	});
	mcp.command("show").description("Show one configured MCP server or the full MCP config").argument("[name]", "MCP server name").option("--json", "Print JSON").action(async (name, opts) => {
		const loaded = await listConfiguredMcpServers();
		if (!loaded.ok) fail(loaded.error);
		const value = name ? loaded.mcpServers[name] : loaded.mcpServers;
		if (name && !value) fail(`No MCP server named "${name}" in ${loaded.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`);
		if (opts.json) {
			printJson(value ?? {});
			return;
		}
		if (name) defaultRuntime.log(`MCP server "${name}" (${loaded.path}):`);
		else defaultRuntime.log(`MCP servers (${loaded.path}):`);
		printJson(value ?? {});
	});
	mcp.command("set").description("Set one configured MCP server from a JSON object").argument("<name>", "MCP server name").argument("<value>", "JSON object, for example {\"command\":\"uvx\",\"args\":[\"context7-mcp\"]}").action(async (name, rawValue) => {
		const parsed = parseConfigValue(rawValue);
		if (parsed.error) fail(parsed.error);
		const result = await setConfiguredMcpServer({
			name,
			server: parsed.value
		});
		if (!result.ok) fail(result.error);
		defaultRuntime.log(`Saved MCP server "${name}" to ${result.path}.`);
	});
	mcp.command("unset").description("Remove one configured MCP server").argument("<name>", "MCP server name").action(async (name) => {
		const result = await unsetConfiguredMcpServer({ name });
		if (!result.ok) fail(result.error);
		if (!result.removed) fail(`No MCP server named "${name}" in ${result.path}. Run ${formatCliCommand("openclaw mcp list")} to see configured servers.`);
		defaultRuntime.log(`Removed MCP server "${name}" from ${result.path}.`);
	});
	applyParentDefaultHelpAction(mcp);
}
//#endregion
export { registerMcpCli };
