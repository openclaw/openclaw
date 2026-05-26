import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import "./agent-harness-runtime-Cs9KBB7L.js";
import { i as isCodexFastServiceTier, r as codexSandboxPolicyForTurn, s as resolveCodexAppServerRuntimeOptions } from "./config-1YKbZ7CA.js";
import { t as isJsonObject } from "./protocol-CJecV8AU.js";
import { n as CODEX_CONTROL_METHODS } from "./request-D-S6onDk.js";
import { r as formatCodexDisplayText } from "./command-formatters-CcSIQReq.js";
import { a as getSharedCodexAppServerClient, u as resolveCodexAppServerAuthProfileIdForAgent } from "./shared-client-3aMgN5po.js";
import { i as readCodexAppServerBinding, n as isCodexAppServerNativeAuthProfile, o as writeCodexAppServerBinding, r as normalizeCodexAppServerBindingModelProvider, t as clearCodexAppServerBinding } from "./session-binding-Dns4vGBT.js";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
//#region extensions/codex/src/conversation-binding-data.ts
const BINDING_DATA_VERSION = 1;
function createCodexConversationBindingData(params) {
	return {
		kind: "codex-app-server-session",
		version: BINDING_DATA_VERSION,
		sessionFile: params.sessionFile,
		workspaceDir: params.workspaceDir
	};
}
function readCodexConversationBindingData(binding) {
	const data = binding?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	return readCodexConversationBindingDataRecord(data);
}
function readCodexConversationBindingDataRecord(data) {
	if (data.kind !== "codex-app-server-session" || data.version !== BINDING_DATA_VERSION || typeof data.sessionFile !== "string" || !data.sessionFile.trim()) return;
	return {
		kind: "codex-app-server-session",
		version: BINDING_DATA_VERSION,
		sessionFile: data.sessionFile,
		workspaceDir: typeof data.workspaceDir === "string" && data.workspaceDir.trim() ? data.workspaceDir : process.cwd()
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
	const binding = await readCodexAppServerBinding(params.sessionFile);
	await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding?.authProfileId
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
	const binding = await readCodexAppServerBinding(params.sessionFile);
	await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding?.authProfileId
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
	const binding = await requireThreadBinding(params.sessionFile);
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const response = await resumeThreadWithOverrides({
		pluginConfig: params.pluginConfig,
		threadId: binding.threadId,
		authProfileId: binding.authProfileId,
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
	});
	return `Codex model set to ${formatCodexDisplayText(response.model ?? model)}.`;
}
async function setCodexConversationFastMode(params) {
	const binding = await requireThreadBinding(params.sessionFile);
	if (params.enabled == null) return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
	const serviceTier = params.enabled ? "priority" : "flex";
	await writeCodexAppServerBinding(params.sessionFile, {
		...binding,
		serviceTier
	});
	return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}
async function setCodexConversationPermissions(params) {
	const binding = await requireThreadBinding(params.sessionFile);
	if (!params.mode) return `Codex permissions: ${formatPermissionsMode(binding)}.`;
	const policy = permissionsForMode(params.mode);
	await writeCodexAppServerBinding(params.sessionFile, {
		...binding,
		approvalPolicy: policy.approvalPolicy,
		sandbox: policy.sandbox
	});
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
async function requireThreadBinding(sessionFile) {
	const binding = await readCodexAppServerBinding(sessionFile);
	if (!binding?.threadId) throw new Error("No Codex thread is attached to this OpenClaw session yet.");
	return binding;
}
async function resumeThreadWithOverrides(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	return await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId
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
		if (!params || readString(params, "threadId") !== threadId) return;
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
	if (readString(params, "threadId") !== threadId) return false;
	if (!turnId) return true;
	const directTurnId = readString(params, "turnId");
	if (directTurnId) return directTurnId === turnId;
	return readString(isJsonObject(params.turn) ? params.turn : void 0, "id") === turnId;
}
function readNotificationTurnId(params) {
	return readString(params, "turnId") ?? readString(readRecord(params.turn), "id");
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
	const existingBinding = await readCodexAppServerBinding(params.sessionFile, { config: params.config });
	const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
		authProfileId: params.authProfileId ?? existingBinding?.authProfileId,
		config: params.config
	});
	if (params.threadId?.trim()) await attachExistingThread({
		pluginConfig: params.pluginConfig,
		sessionFile: params.sessionFile,
		threadId: params.threadId.trim(),
		workspaceDir,
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
		workspaceDir
	});
}
async function handleCodexConversationInboundClaim(event, ctx, options = {}) {
	const data = readCodexConversationBindingData(ctx.pluginBinding);
	if (!data) return;
	if (event.commandAuthorized !== true) return { handled: true };
	const prompt = event.bodyForAgent?.trim() || event.content?.trim() || "";
	if (!prompt) return { handled: true };
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
	if (!data) return;
	await clearCodexAppServerBinding(data.sessionFile);
}
async function attachExistingThread(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const modelProvider = resolveThreadRequestModelProvider({
		authProfileId: params.authProfileId,
		modelProvider: params.modelProvider,
		config: params.config
	});
	const response = await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId
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
			config: params.config,
			authProfileId: params.authProfileId,
			modelProvider: response.modelProvider ?? params.modelProvider
		}),
		approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
		sandbox: params.sandbox ?? runtime.sandbox,
		serviceTier: params.serviceTier ?? runtime.serviceTier
	}, { config: params.config });
}
async function createThread(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const modelProvider = resolveThreadRequestModelProvider({
		authProfileId: params.authProfileId,
		modelProvider: params.modelProvider,
		config: params.config
	});
	const response = await (await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: params.authProfileId
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
			config: params.config,
			authProfileId: params.authProfileId,
			modelProvider: response.modelProvider ?? params.modelProvider
		}),
		approvalPolicy: params.approvalPolicy ?? runtimeApprovalPolicy,
		sandbox: params.sandbox ?? runtime.sandbox,
		serviceTier: params.serviceTier ?? runtime.serviceTier
	}, { config: params.config });
}
async function runBoundTurn(params) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
	const binding = await readCodexAppServerBinding(params.data.sessionFile);
	const threadId = binding?.threadId;
	if (!threadId) throw new Error("bound Codex conversation has no thread binding");
	const client = await getSharedCodexAppServerClient({
		startOptions: runtime.start,
		timeoutMs: runtime.requestTimeoutMs,
		authProfileId: binding.authProfileId
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
		const binding = await readCodexAppServerBinding(params.data.sessionFile);
		await startCodexConversationThread({
			pluginConfig: params.pluginConfig,
			sessionFile: params.data.sessionFile,
			workspaceDir: binding?.cwd || params.data.workspaceDir,
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
//#endregion
export { parseCodexFastModeArg as a, setCodexConversationFastMode as c, steerCodexConversationTurn as d, stopCodexConversationTurn as f, formatPermissionsMode as i, setCodexConversationModel as l, resolveCodexDefaultWorkspaceDir as m, handleCodexConversationInboundClaim as n, parseCodexPermissionsModeArg as o, readCodexConversationBindingData as p, startCodexConversationThread as r, readCodexConversationActiveTurn as s, handleCodexConversationBindingResolved as t, setCodexConversationPermissions as u };
