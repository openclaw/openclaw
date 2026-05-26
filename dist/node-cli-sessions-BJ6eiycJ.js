import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import "./temp-path-DllZid8c.js";
import "./agent-harness-runtime-CMvm9HY6.js";
import { a as isCodexFastServiceTier, l as resolveCodexAppServerRuntimeOptions, r as codexSandboxPolicyForTurn } from "./config-CRe1vCzw.js";
import { t as isJsonObject } from "./protocol-oeJQu4rs.js";
import { i as readCodexAppServerBinding, n as isCodexAppServerNativeAuthProfile, o as writeCodexAppServerBinding, r as normalizeCodexAppServerBindingModelProvider, t as clearCodexAppServerBinding } from "./session-binding-CYVAOy_8.js";
import { n as CODEX_CONTROL_METHODS } from "./request-DXsJgAdp.js";
import { i as readCodexNotificationTurnId, r as readCodexNotificationThreadId, s as formatCodexDisplayText } from "./notification-correlation-qKY_sgga.js";
import { a as getSharedCodexAppServerClient, u as resolveCodexAppServerAuthProfileIdForAgent } from "./shared-client-BGXGt_Pl.js";
import { n as resolveCodexNativeExecutionBlock, r as resolveCodexNativeSandboxBlock } from "./sandbox-guard-DgNmSc4f.js";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
//#region extensions/codex/src/conversation-binding-data.ts
const BINDING_DATA_VERSION = 1;
function createCodexConversationBindingData(params) {
	const agentDir = params.agentDir?.trim();
	return {
		kind: "codex-app-server-session",
		version: BINDING_DATA_VERSION,
		sessionFile: params.sessionFile,
		workspaceDir: params.workspaceDir,
		...agentDir ? { agentDir } : {}
	};
}
function createCodexCliNodeConversationBindingData(params) {
	const cwd = params.cwd?.trim();
	return {
		kind: "codex-cli-node-session",
		version: BINDING_DATA_VERSION,
		nodeId: params.nodeId,
		sessionId: params.sessionId,
		...cwd ? { cwd } : {}
	};
}
function readCodexConversationBindingData(binding) {
	const data = binding?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	return readCodexConversationBindingDataRecord(data);
}
function readCodexConversationBindingDataRecord(data) {
	if (data.kind === "codex-cli-node-session") {
		if (data.version !== BINDING_DATA_VERSION || typeof data.nodeId !== "string" || !data.nodeId.trim() || typeof data.sessionId !== "string" || !data.sessionId.trim()) return;
		return {
			kind: "codex-cli-node-session",
			version: BINDING_DATA_VERSION,
			nodeId: data.nodeId.trim(),
			sessionId: data.sessionId.trim(),
			cwd: typeof data.cwd === "string" && data.cwd.trim() ? data.cwd.trim() : void 0
		};
	}
	if (data.kind !== "codex-app-server-session") return;
	if (data.version !== BINDING_DATA_VERSION || typeof data.sessionFile !== "string" || !data.sessionFile.trim()) return;
	return {
		kind: "codex-app-server-session",
		version: BINDING_DATA_VERSION,
		sessionFile: data.sessionFile,
		workspaceDir: typeof data.workspaceDir === "string" && data.workspaceDir.trim() ? data.workspaceDir : process.cwd(),
		agentDir: typeof data.agentDir === "string" && data.agentDir.trim() ? data.agentDir : void 0
	};
}
function resolveCodexDefaultWorkspaceDir(pluginConfig) {
	return readString$1(readRecord$1(readRecord$1(pluginConfig)?.appServer), "defaultWorkspaceDir") ?? process.cwd();
}
function readRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readString$1(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
//#endregion
//#region extensions/codex/src/conversation-control.ts
const CODEX_CONVERSATION_CONTROL_STATE = Symbol.for("openclaw.codex.conversationControl");
function getActiveTurns() {
	const globalState = globalThis;
	globalState[CODEX_CONVERSATION_CONTROL_STATE] ??= /* @__PURE__ */ new Map();
	return globalState[CODEX_CONVERSATION_CONTROL_STATE];
}
function trackCodexConversationActiveTurn(active) {
	const activeTurns = getActiveTurns();
	activeTurns.set(active.sessionFile, active);
	return () => {
		if (activeTurns.get(active.sessionFile)?.turnId === active.turnId) activeTurns.delete(active.sessionFile);
	};
}
function readCodexConversationActiveTurn(sessionFile) {
	return getActiveTurns().get(sessionFile);
}
async function stopCodexConversationTurn(params) {
	const active = readCodexConversationActiveTurn(params.sessionFile);
	if (!active) return {
		stopped: false,
		message: "No active Codex run to stop."
	};
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const lookup = buildBindingLookup(params);
	const binding = await readCodexAppServerBinding(params.sessionFile, lookup);
	await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding?.authProfileId,
		...lookup
	})).request("turn/interrupt", {
		threadId: active.threadId,
		turnId: active.turnId
	}, { timeoutMs: runtime.requestTimeoutMs });
	return {
		stopped: true,
		message: "Codex stop requested."
	};
}
async function steerCodexConversationTurn(params) {
	const active = readCodexConversationActiveTurn(params.sessionFile);
	const text = params.message.trim();
	if (!text) return {
		steered: false,
		message: "Usage: /codex steer <message>"
	};
	if (!active) return {
		steered: false,
		message: "No active Codex run to steer."
	};
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const lookup = buildBindingLookup(params);
	const binding = await readCodexAppServerBinding(params.sessionFile, lookup);
	await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding?.authProfileId,
		...lookup
	})).request("turn/steer", {
		threadId: active.threadId,
		expectedTurnId: active.turnId,
		input: [{
			type: "text",
			text,
			text_elements: []
		}]
	}, { timeoutMs: runtime.requestTimeoutMs });
	return {
		steered: true,
		message: "Sent steer message to Codex."
	};
}
async function setCodexConversationModel(params) {
	const model = params.model.trim();
	if (!model) return "Usage: /codex model <model>";
	const lookup = buildBindingLookup(params);
	const binding = await requireThreadBinding(params.sessionFile, lookup);
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const response = await resumeThreadWithOverrides({
		pluginConfig: params.pluginConfig,
		threadId: binding.threadId,
		authProfileId: binding.authProfileId,
		...lookup,
		model
	});
	await writeCodexAppServerBinding(params.sessionFile, {
		...binding,
		cwd: response.thread.cwd ?? binding.cwd,
		model: response.model ?? model,
		modelProvider: response.modelProvider ?? binding.modelProvider,
		approvalPolicy: binding.approvalPolicy,
		sandbox: binding.sandbox,
		serviceTier: binding.serviceTier ?? runtime.serviceTier
	}, lookup);
	return `Codex model set to ${formatCodexDisplayText(response.model ?? model)}.`;
}
async function setCodexConversationFastMode(params) {
	const lookup = buildBindingLookup(params);
	const binding = await requireThreadBinding(params.sessionFile, lookup);
	if (params.enabled == null) return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
	const serviceTier = params.enabled ? "priority" : "flex";
	await writeCodexAppServerBinding(params.sessionFile, {
		...binding,
		serviceTier
	}, lookup);
	return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}
async function setCodexConversationPermissions(params) {
	const lookup = buildBindingLookup(params);
	const binding = await requireThreadBinding(params.sessionFile, lookup);
	if (!params.mode) return `Codex permissions: ${formatPermissionsMode(binding)}.`;
	const policy = permissionsForMode(params.mode);
	await writeCodexAppServerBinding(params.sessionFile, {
		...binding,
		approvalPolicy: policy.approvalPolicy,
		sandbox: policy.sandbox
	}, lookup);
	return `Codex permissions set to ${params.mode === "yolo" ? "full access" : "default"}.`;
}
function parseCodexFastModeArg(arg) {
	const normalized = arg?.trim().toLowerCase();
	if (!normalized || normalized === "status") return;
	if (normalized === "on" || normalized === "true" || normalized === "fast") return true;
	if (normalized === "off" || normalized === "false" || normalized === "flex") return false;
}
function parseCodexPermissionsModeArg(arg) {
	const normalized = arg?.trim().toLowerCase();
	if (!normalized || normalized === "status") return;
	if (normalized === "yolo" || normalized === "full" || normalized === "full-access") return "yolo";
	if (normalized === "default" || normalized === "guardian") return "default";
}
function formatPermissionsMode(binding) {
	return binding.approvalPolicy === "never" && binding.sandbox === "danger-full-access" ? "full access" : "default";
}
async function requireThreadBinding(sessionFile, lookup = {}) {
	const binding = await readCodexAppServerBinding(sessionFile, lookup);
	if (!binding?.threadId) throw new Error("No Codex thread is attached to this OpenClaw session yet.");
	return binding;
}
async function resumeThreadWithOverrides(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	return await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId,
		...buildBindingLookup(params)
	})).request(CODEX_CONTROL_METHODS.resumeThread, {
		threadId: params.threadId,
		...params.model ? { model: params.model } : {},
		approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
		sandbox: params.sandbox ?? runtime.sandbox,
		approvalsReviewer: runtime.approvalsReviewer,
		...params.serviceTier ? { serviceTier: params.serviceTier } : {},
		persistExtendedHistory: true
	}, { timeoutMs: runtime.requestTimeoutMs });
}
function buildBindingLookup(params) {
	const agentDir = params.agentDir?.trim();
	return {
		...agentDir ? { agentDir } : {},
		...params.config ? { config: params.config } : {}
	};
}
function permissionsForMode(mode) {
	return mode === "yolo" ? {
		approvalPolicy: "never",
		sandbox: "danger-full-access"
	} : {
		approvalPolicy: "on-request",
		sandbox: "workspace-write"
	};
}
//#endregion
//#region extensions/codex/src/conversation-turn-collector.ts
const MAX_PENDING_NOTIFICATIONS_PER_TURN = 100;
function createCodexConversationTurnCollector(threadId) {
	let turnId;
	let completed = false;
	let failedError;
	let timeout;
	const assistantTextByItem = /* @__PURE__ */ new Map();
	const assistantOrder = [];
	const pendingNotificationsByTurnId = /* @__PURE__ */ new Map();
	let resolveCompletion;
	let rejectCompletion;
	const rememberItem = (itemId) => {
		if (!assistantOrder.includes(itemId)) assistantOrder.push(itemId);
	};
	const collectReplyText = () => {
		return assistantOrder.map((itemId) => assistantTextByItem.get(itemId)?.trim()).filter((text) => Boolean(text)).at(-1) ?? "";
	};
	const clearWaitState = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = void 0;
		}
		resolveCompletion = void 0;
		rejectCompletion = void 0;
	};
	const finish = () => {
		if (completed) return;
		completed = true;
		if (failedError) rejectCompletion?.(new Error(failedError));
		else resolveCompletion?.({ replyText: collectReplyText() });
		clearWaitState();
	};
	const handleNotification = (notification) => {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params || readCodexNotificationThreadId(params) !== threadId) return;
		if (!turnId) {
			const pendingTurnId = readNotificationTurnId(params);
			if (pendingTurnId) {
				const pending = pendingNotificationsByTurnId.get(pendingTurnId) ?? [];
				if (pending.length < MAX_PENDING_NOTIFICATIONS_PER_TURN) {
					pending.push(notification);
					pendingNotificationsByTurnId.set(pendingTurnId, pending);
				}
			}
			return;
		}
		if (!isNotificationForTurn(params, threadId, turnId)) return;
		if (notification.method === "item/agentMessage/delta") {
			const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
			const delta = readTextString(params, "delta");
			if (!delta) return;
			rememberItem(itemId);
			assistantTextByItem.set(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
			return;
		}
		if (notification.method === "item/completed") {
			const item = isJsonObject(params.item) ? params.item : void 0;
			if (item?.type === "agentMessage") {
				const itemId = readString(item, "id") ?? readString(params, "itemId") ?? "assistant";
				const text = readTextString(item, "text");
				if (text) {
					rememberItem(itemId);
					assistantTextByItem.set(itemId, text);
				}
			}
			return;
		}
		if (notification.method === "turn/completed") {
			const turn = isJsonObject(params.turn) ? params.turn : void 0;
			if (readString(turn, "status") === "failed") failedError = readString(readRecord(turn?.error), "message") ?? "codex app-server turn failed";
			const items = Array.isArray(turn?.items) ? turn.items : [];
			for (const item of items) {
				if (!isJsonObject(item) || item.type !== "agentMessage") continue;
				const itemId = readString(item, "id") ?? `assistant-${assistantOrder.length + 1}`;
				const text = readTextString(item, "text");
				if (text) {
					rememberItem(itemId);
					assistantTextByItem.set(itemId, text);
				}
			}
			finish();
		}
	};
	return {
		setTurnId(nextTurnId) {
			turnId = nextTurnId;
			const pending = pendingNotificationsByTurnId.get(nextTurnId) ?? [];
			pendingNotificationsByTurnId.clear();
			for (const notification of pending) handleNotification(notification);
		},
		handleNotification,
		wait(params) {
			if (completed) return failedError ? Promise.reject(new Error(failedError)) : Promise.resolve({ replyText: collectReplyText() });
			return new Promise((resolve, reject) => {
				resolveCompletion = resolve;
				rejectCompletion = reject;
				timeout = setTimeout(() => {
					completed = true;
					reject(/* @__PURE__ */ new Error("codex app-server bound turn timed out"));
					clearWaitState();
				}, Math.max(100, params.timeoutMs));
				timeout.unref?.();
			});
		}
	};
}
function isNotificationForTurn(params, threadId, turnId) {
	if (readCodexNotificationThreadId(params) !== threadId) return false;
	if (!turnId) return true;
	const directTurnId = readString(params, "turnId");
	if (directTurnId) return directTurnId === turnId;
	return readString(isJsonObject(params.turn) ? params.turn : void 0, "id") === turnId;
}
function readNotificationTurnId(params) {
	return readCodexNotificationTurnId(params);
}
function readRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readString(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readTextString(record, key) {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
//#endregion
//#region extensions/codex/src/conversation-turn-input.ts
const IMAGE_EXTENSIONS = new Set([
	".avif",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".webp"
]);
function buildCodexConversationTurnInput(params) {
	return [{
		type: "text",
		text: params.prompt,
		text_elements: []
	}, ...extractInboundMedia(params.event).map(toCodexImageInput).filter((item) => item !== void 0)];
}
function extractInboundMedia(event) {
	const metadata = event.metadata ?? {};
	const paths = readStringArray(metadata.mediaPaths).concat(readStringArray(metadata.mediaPath));
	const urls = readStringArray(metadata.mediaUrls).concat(readStringArray(metadata.mediaUrl));
	const mimeTypes = readStringArray(metadata.mediaTypes).concat(readStringArray(metadata.mediaType));
	const count = Math.max(paths.length, urls.length, mimeTypes.length);
	const media = [];
	for (let index = 0; index < count; index += 1) media.push({
		path: paths[index],
		url: urls[index],
		mimeType: mimeTypes[index] ?? mimeTypes[0]
	});
	return media;
}
function toCodexImageInput(media) {
	if (!isImageMedia(media)) return;
	const localPath = media.path ?? readLocalMediaPath(media.url);
	if (localPath) {
		const normalized = normalizeFileUrl(localPath);
		return normalized ? {
			type: "localImage",
			path: normalized
		} : void 0;
	}
	return media.url ? {
		type: "image",
		url: media.url
	} : void 0;
}
function isImageMedia(media) {
	if (media.mimeType?.toLowerCase().startsWith("image/")) return true;
	const candidate = media.path ?? media.url;
	if (!candidate) return false;
	return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}
function normalizeFileUrl(value) {
	if (!value.startsWith("file://")) return value;
	try {
		return fileURLToPath(value);
	} catch {
		return;
	}
}
function readLocalMediaPath(value) {
	if (!value) return;
	if (value.startsWith("file://")) return value;
	if (value.startsWith("//")) return;
	if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return value;
	return /^[a-z][a-z0-9+.-]*:/i.test(value) ? void 0 : value;
}
function readStringArray(value) {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
//#endregion
//#region extensions/codex/src/conversation-binding.ts
const DEFAULT_BOUND_TURN_TIMEOUT_MS = 20 * 6e4;
const CODEX_CONVERSATION_GLOBAL_STATE = Symbol.for("openclaw.codex.conversationBinding");
function getGlobalState() {
	const globalState = globalThis;
	globalState[CODEX_CONVERSATION_GLOBAL_STATE] ??= { queues: /* @__PURE__ */ new Map() };
	return globalState[CODEX_CONVERSATION_GLOBAL_STATE];
}
async function startCodexConversationThread(params) {
	const workspaceDir = params.workspaceDir?.trim() || resolveCodexDefaultWorkspaceDir(params.pluginConfig);
	const agentDir = params.agentDir?.trim();
	const agentLookup = buildAgentLookup({
		agentDir,
		config: params.config
	});
	const existingBinding = await readCodexAppServerBinding(params.sessionFile, { ...agentLookup });
	const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
		authProfileId: params.authProfileId ?? existingBinding?.authProfileId,
		...agentLookup
	});
	if (params.threadId?.trim()) await attachExistingThread({
		pluginConfig: params.pluginConfig,
		sessionFile: params.sessionFile,
		threadId: params.threadId.trim(),
		workspaceDir,
		...agentDir ? { agentDir } : {},
		model: params.model,
		modelProvider: params.modelProvider,
		authProfileId,
		approvalPolicy: params.approvalPolicy,
		sandbox: params.sandbox,
		serviceTier: params.serviceTier,
		config: params.config
	});
	else await createThread({
		pluginConfig: params.pluginConfig,
		sessionFile: params.sessionFile,
		workspaceDir,
		...agentDir ? { agentDir } : {},
		model: params.model,
		modelProvider: params.modelProvider,
		authProfileId,
		approvalPolicy: params.approvalPolicy,
		sandbox: params.sandbox,
		serviceTier: params.serviceTier,
		config: params.config
	});
	return createCodexConversationBindingData({
		sessionFile: params.sessionFile,
		workspaceDir,
		...agentDir ? { agentDir } : {}
	});
}
async function handleCodexConversationInboundClaim(event, ctx, options = {}) {
	const data = readCodexConversationBindingData(ctx.pluginBinding);
	if (!data) return;
	if (event.commandAuthorized !== true) return { handled: true };
	const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
	if (!prompt) return { handled: true };
	const nativeExecutionBlock = data.kind === "codex-cli-node-session" ? resolveCodexNativeSandboxBlock({
		config: options.config,
		sessionKey: event.sessionKey ?? ctx.sessionKey,
		surface: "Codex CLI node conversation binding"
	}) : resolveCodexNativeExecutionBlock({
		config: options.config,
		sessionKey: event.sessionKey ?? ctx.sessionKey,
		surface: "Codex app-server conversation binding"
	});
	if (nativeExecutionBlock) return {
		handled: true,
		reply: { text: nativeExecutionBlock }
	};
	if (data.kind === "codex-cli-node-session") {
		const resume = options.resumeCodexCliSessionOnNode;
		if (!resume) return {
			handled: true,
			reply: { text: "Codex CLI node binding is unavailable because Gateway node runtime is not attached." }
		};
		try {
			return {
				handled: true,
				reply: (await enqueueBoundTurn(`${data.nodeId}:${data.sessionId}`, async () => {
					return { reply: { text: (await resume({
						nodeId: data.nodeId,
						sessionId: data.sessionId,
						prompt,
						cwd: data.cwd,
						timeoutMs: options.timeoutMs
					})).text.trim() || "Codex completed without a text reply." } };
				})).reply
			};
		} catch (error) {
			return {
				handled: true,
				reply: { text: `Codex CLI node turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}` }
			};
		}
	}
	try {
		return {
			handled: true,
			reply: (await enqueueBoundTurn(data.sessionFile, () => runBoundTurnWithMissingThreadRecovery({
				data,
				prompt,
				event,
				pluginConfig: options.pluginConfig,
				timeoutMs: options.timeoutMs
			}))).reply
		};
	} catch (error) {
		return {
			handled: true,
			reply: { text: `Codex app-server turn failed: ${formatCodexDisplayText(formatErrorMessage(error))}` }
		};
	}
}
async function handleCodexConversationBindingResolved(event) {
	if (event.status !== "denied") return;
	const data = readCodexConversationBindingDataRecord(event.request.data ?? {});
	if (!data || data.kind !== "codex-app-server-session") return;
	await clearCodexAppServerBinding(data.sessionFile);
}
async function attachExistingThread(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const agentLookup = buildAgentLookup({
		agentDir: params.agentDir,
		config: params.config
	});
	const modelProvider = resolveThreadRequestModelProvider({
		authProfileId: params.authProfileId,
		modelProvider: params.modelProvider,
		...agentLookup
	});
	const response = await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId,
		...agentLookup
	})).request(CODEX_CONTROL_METHODS.resumeThread, {
		threadId: params.threadId,
		...params.model ? { model: params.model } : {},
		...modelProvider ? { modelProvider } : {},
		approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
		approvalsReviewer: runtime.approvalsReviewer,
		sandbox: params.sandbox ?? runtime.sandbox,
		...params.serviceTier ?? runtime.serviceTier ? { serviceTier: params.serviceTier ?? runtime.serviceTier } : {},
		persistExtendedHistory: true
	}, { timeoutMs: runtime.requestTimeoutMs });
	const thread = response.thread;
	const runtimeApprovalPolicy = typeof runtime.approvalPolicy === "string" ? runtime.approvalPolicy : void 0;
	await writeCodexAppServerBinding(params.sessionFile, {
		threadId: thread.id,
		cwd: thread.cwd ?? params.workspaceDir,
		authProfileId: params.authProfileId,
		model: response.model ?? params.model,
		modelProvider: normalizeCodexAppServerBindingModelProvider({
			authProfileId: params.authProfileId,
			modelProvider: response.modelProvider ?? params.modelProvider,
			...agentLookup
		}),
		approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
		sandbox: params.sandbox ?? runtime.sandbox,
		serviceTier: params.serviceTier ?? runtime.serviceTier
	}, { ...agentLookup });
}
async function createThread(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const agentLookup = buildAgentLookup({
		agentDir: params.agentDir,
		config: params.config
	});
	const modelProvider = resolveThreadRequestModelProvider({
		authProfileId: params.authProfileId,
		modelProvider: params.modelProvider,
		...agentLookup
	});
	const response = await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId,
		...agentLookup
	})).request("thread/start", {
		cwd: params.workspaceDir,
		...params.model ? { model: params.model } : {},
		...modelProvider ? { modelProvider } : {},
		approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
		approvalsReviewer: runtime.approvalsReviewer,
		sandbox: params.sandbox ?? runtime.sandbox,
		...params.serviceTier ?? runtime.serviceTier ? { serviceTier: params.serviceTier ?? runtime.serviceTier } : {},
		developerInstructions: "This Codex thread is bound to an OpenClaw conversation. Answer normally; OpenClaw will deliver your final response back to the conversation.",
		experimentalRawEvents: true,
		persistExtendedHistory: true
	}, { timeoutMs: runtime.requestTimeoutMs });
	const runtimeApprovalPolicy = typeof runtime.approvalPolicy === "string" ? runtime.approvalPolicy : void 0;
	await writeCodexAppServerBinding(params.sessionFile, {
		threadId: response.thread.id,
		cwd: response.thread.cwd ?? params.workspaceDir,
		authProfileId: params.authProfileId,
		model: response.model ?? params.model,
		modelProvider: normalizeCodexAppServerBindingModelProvider({
			authProfileId: params.authProfileId,
			modelProvider: response.modelProvider ?? params.modelProvider,
			...agentLookup
		}),
		approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
		sandbox: params.sandbox ?? runtime.sandbox,
		serviceTier: params.serviceTier ?? runtime.serviceTier
	}, { ...agentLookup });
}
async function runBoundTurn(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir });
	const binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
	const threadId = binding?.threadId;
	if (!threadId) throw new Error("bound Codex conversation has no thread binding");
	const client = await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding.authProfileId,
		...agentLookup
	});
	const collector = createCodexConversationTurnCollector(threadId);
	const notificationCleanup = client.addNotificationHandler((notification) => collector.handleNotification(notification));
	const requestCleanup = client.addRequestHandler(async (request) => {
		if (request.method === "item/tool/call") return {
			contentItems: [{
				type: "inputText",
				text: "OpenClaw native Codex conversation binding does not expose dynamic OpenClaw tools yet."
			}],
			success: false
		};
		if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return {
			decision: "decline",
			reason: "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow."
		};
		if (request.method === "item/permissions/requestApproval") return {
			permissions: {},
			scope: "turn"
		};
		if (request.method.includes("requestApproval")) return {
			decision: "decline",
			reason: "OpenClaw native Codex conversation binding cannot route interactive approvals yet; use the Codex harness or explicit /acp spawn codex for that workflow."
		};
	});
	try {
		const turnId = (await client.request("turn/start", {
			threadId,
			input: buildCodexConversationTurnInput({
				prompt: params.prompt,
				event: params.event
			}),
			cwd: binding.cwd || params.data.workspaceDir,
			approvalPolicy: binding.approvalPolicy ?? runtime.approvalPolicy,
			approvalsReviewer: runtime.approvalsReviewer,
			sandboxPolicy: codexSandboxPolicyForTurn(binding.sandbox ?? runtime.sandbox, binding.cwd || params.data.workspaceDir),
			...binding.model ? { model: binding.model } : {},
			...binding.serviceTier ?? runtime.serviceTier ? { serviceTier: binding.serviceTier ?? runtime.serviceTier } : {}
		}, { timeoutMs: runtime.requestTimeoutMs })).turn.id;
		const activeCleanup = trackCodexConversationActiveTurn({
			sessionFile: params.data.sessionFile,
			threadId,
			turnId
		});
		collector.setTurnId(turnId);
		return { reply: { text: (await collector.wait({ timeoutMs: params.timeoutMs ?? DEFAULT_BOUND_TURN_TIMEOUT_MS }).finally(activeCleanup)).replyText.trim() || "Codex completed without a text reply." } };
	} finally {
		notificationCleanup();
		requestCleanup();
	}
}
async function runBoundTurnWithMissingThreadRecovery(params) {
	try {
		return await runBoundTurn(params);
	} catch (error) {
		if (!isCodexThreadNotFoundError(error)) throw error;
		const agentLookup = buildAgentLookup({ agentDir: params.data.agentDir });
		const binding = await readCodexAppServerBinding(params.data.sessionFile, agentLookup);
		await startCodexConversationThread({
			pluginConfig: params.pluginConfig,
			sessionFile: params.data.sessionFile,
			workspaceDir: binding?.cwd || params.data.workspaceDir,
			...agentLookup,
			model: binding?.model,
			modelProvider: binding?.modelProvider,
			authProfileId: binding?.authProfileId,
			approvalPolicy: binding?.approvalPolicy,
			sandbox: binding?.sandbox,
			serviceTier: binding?.serviceTier
		});
		return await runBoundTurn(params);
	}
}
function isCodexThreadNotFoundError(error) {
	return /\bthread not found:/iu.test(formatErrorMessage(error));
}
function enqueueBoundTurn(key, run) {
	const state = getGlobalState();
	const next = (state.queues.get(key) ?? Promise.resolve()).then(run, run);
	const queued = next.then(() => void 0, () => void 0);
	state.queues.set(key, queued);
	next.finally(() => {
		if (state.queues.get(key) === queued) state.queues.delete(key);
	}).catch(() => void 0);
	return next;
}
function resolveThreadRequestModelProvider(params) {
	const modelProvider = params.modelProvider?.trim();
	if (!modelProvider || modelProvider.toLowerCase() === "codex") return;
	if (isCodexAppServerNativeAuthProfile(params) && (modelProvider.toLowerCase() === "openai" || modelProvider.toLowerCase() === "openai-codex")) return;
	return modelProvider.toLowerCase() === "openai-codex" ? "openai" : modelProvider;
}
function buildAgentLookup(params) {
	const agentDir = params.agentDir?.trim();
	return {
		...agentDir ? { agentDir } : {},
		...params.config ? { config: params.config } : {}
	};
}
//#endregion
//#region extensions/codex/src/node-cli-sessions.ts
const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";
const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";
const DEFAULT_SESSION_LIMIT = 10;
const MAX_SESSION_LIMIT = 50;
const DEFAULT_RESUME_TIMEOUT_MS = 20 * 6e4;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const activeResumeSessions = /* @__PURE__ */ new Set();
const DEFAULT_RESUME_SPAWN_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function createCodexCliSessionNodeHostCommands() {
	return [{
		command: CODEX_CLI_SESSIONS_LIST_COMMAND,
		cap: "codex-cli-sessions",
		handle: listLocalCodexCliSessions
	}, {
		command: CODEX_CLI_SESSION_RESUME_COMMAND,
		cap: "codex-cli-sessions",
		dangerous: true,
		handle: resumeLocalCodexCliSession
	}];
}
function createCodexCliSessionNodeInvokePolicies() {
	return [{
		commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
		defaultPlatforms: [
			"macos",
			"linux",
			"windows"
		],
		handle: (ctx) => ctx.invokeNode()
	}, {
		commands: [CODEX_CLI_SESSION_RESUME_COMMAND],
		dangerous: true,
		handle: (ctx) => ctx.invokeNode()
	}];
}
async function listCodexCliSessionsOnNode(params) {
	const node = await resolveCodexCliNode({
		runtime: params.runtime,
		requestedNode: params.requestedNode,
		command: CODEX_CLI_SESSIONS_LIST_COMMAND
	});
	return {
		node,
		result: parseCodexCliSessionsListResult(await params.runtime.nodes.invoke({
			nodeId: readNodeId(node),
			command: CODEX_CLI_SESSIONS_LIST_COMMAND,
			params: {
				limit: params.limit,
				filter: params.filter
			},
			timeoutMs: 15e3
		}))
	};
}
async function resolveCodexCliSessionForBindingOnNode(params) {
	const listing = await listCodexCliSessionsOnNode({
		runtime: params.runtime,
		requestedNode: params.requestedNode,
		filter: params.sessionId,
		limit: MAX_SESSION_LIMIT
	});
	if (!listing.node.commands?.includes("codex.cli.session.resume")) throw new Error(`Node ${formatNodeLabel(listing.node)} does not expose ${CODEX_CLI_SESSION_RESUME_COMMAND}.`);
	return {
		node: listing.node,
		session: listing.result.sessions.find((session) => session.sessionId === params.sessionId)
	};
}
async function resumeCodexCliSessionOnNode(params) {
	const payload = unwrapNodeInvokePayload(await params.runtime.nodes.invoke({
		nodeId: params.nodeId,
		command: CODEX_CLI_SESSION_RESUME_COMMAND,
		params: {
			sessionId: params.sessionId,
			prompt: params.prompt,
			cwd: params.cwd,
			timeoutMs: params.timeoutMs
		},
		timeoutMs: (params.timeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS) + 5e3
	}));
	if (!isRecord(payload) || payload.ok !== true || typeof payload.text !== "string") throw new Error("Codex CLI resume returned an invalid payload.");
	return {
		ok: true,
		sessionId: typeof payload.sessionId === "string" ? payload.sessionId : params.sessionId,
		text: payload.text
	};
}
function formatCodexCliSessions(params) {
	if (params.result.sessions.length === 0) return `No Codex CLI sessions returned from ${formatCodexDisplayText(formatNodeLabel(params.node))}.`;
	return [`Codex CLI sessions on ${formatCodexDisplayText(formatNodeLabel(params.node))}:`, ...params.result.sessions.map((session) => {
		const details = [session.cwd, session.updatedAt].filter((value) => Boolean(value));
		return `- ${formatCodexDisplayText(session.sessionId)}${session.lastMessage ? ` - ${formatCodexDisplayText(session.lastMessage)}` : ""}${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Bind: /codex resume ${formatCodexDisplayText(session.sessionId)} --host ${formatCodexDisplayText(readNodeId(params.node))} --bind here`;
	})].join("\n");
}
async function listLocalCodexCliSessions(paramsJSON) {
	const params = readRecordParam(paramsJSON);
	const limit = normalizeLimit(params.limit);
	const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
	const codexHome = resolveCodexHome();
	const summaries = await readHistorySessions(codexHome);
	await hydrateSessionFiles(codexHome, summaries);
	await hydrateSessionsFromSessionFiles(codexHome, summaries);
	const sessions = [...summaries.values()].filter((session) => {
		if (!filter) return true;
		return [
			session.sessionId,
			session.cwd,
			session.lastMessage
		].some((value) => value?.toLowerCase().includes(filter));
	}).toSorted((a, b) => compareOptionalStringsDesc(a.updatedAt, b.updatedAt)).slice(0, limit);
	return JSON.stringify({
		sessions,
		codexHome
	});
}
async function resumeLocalCodexCliSession(paramsJSON) {
	const params = readRecordParam(paramsJSON);
	const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
	const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
	if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) throw new Error("Missing or invalid Codex CLI session id.");
	if (!prompt) throw new Error("Missing Codex CLI prompt.");
	if (activeResumeSessions.has(sessionId)) throw new Error(`Codex CLI session ${sessionId} already has an active resume turn.`);
	activeResumeSessions.add(sessionId);
	try {
		const text = await runCodexExecResume({
			sessionId,
			prompt,
			cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : void 0,
			timeoutMs: normalizeTimeoutMs(params.timeoutMs)
		});
		return JSON.stringify({
			ok: true,
			sessionId,
			text: text.trim() || "Codex completed without a text reply."
		});
	} finally {
		activeResumeSessions.delete(sessionId);
	}
}
async function runCodexExecResume(params) {
	const outputPath = path.join(await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-cli-")), "last-message.txt");
	try {
		const invocation = resolveCodexCliResumeSpawnInvocation([
			"exec",
			"resume",
			"--skip-git-repo-check",
			"--output-last-message",
			outputPath,
			params.sessionId,
			"-"
		], {
			platform: process.platform,
			env: process.env,
			execPath: process.execPath
		});
		const child = spawn(invocation.command, invocation.args, {
			cwd: params.cwd || process.cwd(),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: process.env,
			shell: invocation.shell,
			windowsHide: invocation.windowsHide
		});
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		let forceKillTimeout;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 2e3);
			forceKillTimeout.unref?.();
		}, params.timeoutMs);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.stdin.end(params.prompt);
		const exitCode = await new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code) => resolve(code));
		}).finally(() => {
			clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
		});
		if (timedOut) throw new Error(`codex exec resume timed out after ${String(params.timeoutMs)}ms`);
		if (exitCode !== 0) {
			const message = Buffer.concat(stderr).toString("utf8").trim() || Buffer.concat(stdout).toString("utf8").trim() || `codex exec resume exited with code ${String(exitCode)}`;
			throw new Error(message);
		}
		return await fs.readFile(outputPath, "utf8");
	} finally {
		await fs.rm(path.dirname(outputPath), {
			recursive: true,
			force: true
		});
	}
}
function resolveCodexCliResumeSpawnInvocation(args, runtime = DEFAULT_RESUME_SPAWN_RUNTIME) {
	const resolved = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: "codex",
		platform: runtime.platform,
		env: runtime.env,
		execPath: runtime.execPath,
		packageName: "@openai/codex"
	}), args);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
async function readHistorySessions(codexHome) {
	const summaries = /* @__PURE__ */ new Map();
	const content = await readFileIfExists(path.join(codexHome, "history.jsonl"));
	if (!content) return summaries;
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.session_id !== "string") continue;
		const sessionId = parsed.session_id.trim();
		if (!sessionId) continue;
		const entry = summaries.get(sessionId) ?? {
			sessionId,
			messageCount: 0
		};
		entry.messageCount += 1;
		if (typeof parsed.text === "string" && parsed.text.trim()) entry.lastMessage = truncateText(parsed.text.trim(), 140);
		if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) entry.updatedAt = (/* @__PURE__ */ new Date(parsed.ts * 1e3)).toISOString();
		summaries.set(sessionId, entry);
	}
	return summaries;
}
async function hydrateSessionFiles(codexHome, summaries) {
	if (summaries.size === 0) return;
	const files = await findSessionFiles(path.join(codexHome, "sessions"), 4);
	const pending = new Set(summaries.keys());
	for (const file of files) {
		const basename = path.basename(file);
		const sessionId = [...pending].find((id) => basename.includes(id));
		if (!sessionId) continue;
		const entry = summaries.get(sessionId);
		if (!entry) continue;
		entry.sessionFile = file;
		const cwd = readSessionMetaCwd(await readFirstLine(file) ?? "");
		if (cwd) entry.cwd = cwd;
		pending.delete(sessionId);
		if (pending.size === 0) return;
	}
}
async function hydrateSessionsFromSessionFiles(codexHome, summaries) {
	const files = await findSessionFiles(path.join(codexHome, "sessions"), 4);
	for (const file of files) {
		const summary = await readSessionFileSummary(file);
		if (!summary) continue;
		const existing = summaries.get(summary.sessionId);
		summaries.set(summary.sessionId, {
			...summary,
			...existing,
			cwd: existing?.cwd ?? summary.cwd,
			sessionFile: existing?.sessionFile ?? summary.sessionFile,
			updatedAt: existing?.updatedAt ?? summary.updatedAt,
			lastMessage: existing?.lastMessage ?? summary.lastMessage,
			messageCount: existing?.messageCount ?? summary.messageCount
		});
	}
}
async function readSessionFileSummary(file) {
	const content = await readFileIfExists(file);
	if (!content) return null;
	let sessionId = "";
	let cwd;
	let updatedAt;
	let lastMessage;
	let messageCount = 0;
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) updatedAt = parsed.timestamp.trim();
		if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
			if (typeof parsed.payload.id === "string" && parsed.payload.id.trim()) sessionId = parsed.payload.id.trim();
			if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()) cwd = parsed.payload.cwd.trim();
			continue;
		}
		const messageText = readResponseItemMessageText(parsed);
		if (messageText) {
			messageCount += 1;
			lastMessage = truncateText(messageText, 140);
		}
	}
	if (!sessionId) sessionId = readSessionIdFromFilename(file) ?? "";
	if (!sessionId) return null;
	return {
		sessionId,
		updatedAt: updatedAt ?? await readFileMtimeIso(file),
		lastMessage,
		cwd,
		sessionFile: file,
		messageCount
	};
}
async function findSessionFiles(dir, maxDepth) {
	if (maxDepth < 0) return [];
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await findSessionFiles(entryPath, maxDepth - 1));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
	}
	return files;
}
function readSessionMetaCwd(line) {
	try {
		const parsed = JSON.parse(line);
		if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) return;
		return typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim() ? parsed.payload.cwd.trim() : void 0;
	} catch {
		return;
	}
}
function readResponseItemMessageText(parsed) {
	if (parsed.type !== "response_item" || !isRecord(parsed.payload)) return;
	if (parsed.payload.type !== "message") return;
	if ((typeof parsed.payload.role === "string" ? parsed.payload.role : "") !== "user") return;
	const parts = (Array.isArray(parsed.payload.content) ? parsed.payload.content : []).flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const text = typeof entry.text === "string" ? entry.text : typeof entry.input_text === "string" ? entry.input_text : void 0;
		return text?.trim() ? [text.trim()] : [];
	});
	return parts.length > 0 ? parts.join(" ") : void 0;
}
function readSessionIdFromFilename(file) {
	return path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu)?.[0];
}
async function resolveCodexCliNode(params) {
	const list = await params.runtime.nodes.list(params.requestedNode ? void 0 : { connected: true });
	const requested = params.requestedNode?.trim();
	const candidates = list.nodes.filter((node) => {
		if (requested) return [
			node.nodeId,
			node.displayName,
			node.remoteIp
		].some((value) => value === requested);
		return node.connected === true && node.commands?.includes(params.command);
	});
	if (candidates.length === 0) throw new Error(requested ? `Codex CLI node ${requested} was not found.` : "No connected node exposes Codex CLI session commands.");
	const usable = candidates.filter((node) => node.commands?.includes(params.command));
	if (usable.length === 0) throw new Error(`Node ${requested ?? "candidate"} does not expose ${params.command}.`);
	if (usable.length > 1) throw new Error("Multiple Codex CLI-capable nodes connected. Pass --host <node-id>.");
	return usable[0];
}
function parseCodexCliSessionsListResult(raw) {
	const payload = unwrapNodeInvokePayload(raw);
	if (!isRecord(payload) || !Array.isArray(payload.sessions)) throw new Error("Codex CLI session list returned an invalid payload.");
	return {
		codexHome: typeof payload.codexHome === "string" ? payload.codexHome : "",
		sessions: payload.sessions.flatMap((entry) => {
			if (!isRecord(entry) || typeof entry.sessionId !== "string") return [];
			return [{
				sessionId: entry.sessionId,
				updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : void 0,
				lastMessage: typeof entry.lastMessage === "string" ? entry.lastMessage : void 0,
				cwd: typeof entry.cwd === "string" ? entry.cwd : void 0,
				sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : void 0,
				messageCount: typeof entry.messageCount === "number" && Number.isFinite(entry.messageCount) ? entry.messageCount : 0
			}];
		})
	};
}
function unwrapNodeInvokePayload(raw) {
	const record = isRecord(raw) ? raw : {};
	if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) try {
		return JSON.parse(record.payloadJSON);
	} catch (error) {
		throw new Error("Codex CLI node command returned malformed payloadJSON.", { cause: error });
	}
	if ("payload" in record) return record.payload;
	return raw;
}
function readRecordParam(paramsJSON) {
	if (!paramsJSON?.trim()) return {};
	try {
		const parsed = JSON.parse(paramsJSON);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
function resolveCodexHome() {
	return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}
async function readFileIfExists(file) {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return;
	}
}
async function readFirstLine(file) {
	return (await readFileIfExists(file))?.split(/\r?\n/u)[0];
}
async function readFileMtimeIso(file) {
	try {
		return (await fs.stat(file)).mtime.toISOString();
	} catch {
		return;
	}
}
function normalizeLimit(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(value))) : DEFAULT_SESSION_LIMIT;
}
function normalizeTimeoutMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(60 * 6e4, Math.floor(value)) : DEFAULT_RESUME_TIMEOUT_MS;
}
function truncateText(value, max) {
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
function compareOptionalStringsDesc(a, b) {
	return (b ?? "").localeCompare(a ?? "");
}
function readNodeId(node) {
	if (!node.nodeId) throw new Error("Codex CLI node did not include a node id.");
	return node.nodeId;
}
function formatNodeLabel(node) {
	return [
		node.displayName,
		node.nodeId,
		node.remoteIp
	].filter(Boolean).join(" / ") || "node";
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
//#endregion
export { steerCodexConversationTurn as _, resolveCodexCliSessionForBindingOnNode as a, readCodexConversationBindingData as b, handleCodexConversationInboundClaim as c, parseCodexFastModeArg as d, parseCodexPermissionsModeArg as f, setCodexConversationPermissions as g, setCodexConversationModel as h, listCodexCliSessionsOnNode as i, startCodexConversationThread as l, setCodexConversationFastMode as m, createCodexCliSessionNodeInvokePolicies as n, resumeCodexCliSessionOnNode as o, readCodexConversationActiveTurn as p, formatCodexCliSessions as r, handleCodexConversationBindingResolved as s, createCodexCliSessionNodeHostCommands as t, formatPermissionsMode as u, stopCodexConversationTurn as v, resolveCodexDefaultWorkspaceDir as x, createCodexCliNodeConversationBindingData as y };
