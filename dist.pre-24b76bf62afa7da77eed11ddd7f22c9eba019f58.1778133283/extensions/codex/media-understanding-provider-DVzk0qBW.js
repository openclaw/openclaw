import { i as FALLBACK_CODEX_MODELS, r as CODEX_PROVIDER_ID } from "./provider-catalog-B5KWE11O.js";
import { i as resolveCodexAppServerRuntimeOptions } from "./config-DFyAu0jI.js";
import { a as readCodexErrorNotification, c as readCodexTurnCompletedNotification, n as assertCodexThreadStartResponse, r as assertCodexTurnStartResponse } from "./protocol-validators-B5rJANxm.js";
import { r as readModelListResult } from "./models-2JNZEYbP.js";
import { t as isJsonObject } from "./protocol-uvBhUxI5.js";
//#region extensions/codex/media-understanding-provider.ts
const DEFAULT_CODEX_IMAGE_MODEL = FALLBACK_CODEX_MODELS.find((model) => model.inputModalities.includes("image"))?.id ?? FALLBACK_CODEX_MODELS[0]?.id;
const DEFAULT_CODEX_IMAGE_PROMPT = "Describe the image.";
function buildCodexMediaUnderstandingProvider(options = {}) {
	return {
		id: CODEX_PROVIDER_ID,
		capabilities: ["image"],
		...DEFAULT_CODEX_IMAGE_MODEL ? { defaultModels: { image: DEFAULT_CODEX_IMAGE_MODEL } } : {},
		describeImage: async (req) => describeCodexImages({
			images: [{
				buffer: req.buffer,
				fileName: req.fileName,
				mime: req.mime
			}],
			provider: req.provider,
			model: req.model,
			prompt: req.prompt,
			maxTokens: req.maxTokens,
			timeoutMs: req.timeoutMs,
			profile: req.profile,
			preferredProfile: req.preferredProfile,
			authStore: req.authStore,
			agentDir: req.agentDir,
			cfg: req.cfg
		}, options),
		describeImages: async (req) => describeCodexImages(req, options)
	};
}
async function describeCodexImages(req, options) {
	const model = req.model.trim();
	if (!model) throw new Error("Codex image understanding requires model id.");
	const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
	const timeoutMs = Math.max(100, req.timeoutMs);
	const ownsClient = !options.clientFactory;
	const client = options.clientFactory ? await options.clientFactory(appServer.start, req.profile) : await import("./shared-client-C754sdEb.js").then(({ createIsolatedCodexAppServerClient }) => createIsolatedCodexAppServerClient({
		startOptions: appServer.start,
		timeoutMs,
		authProfileId: req.profile
	}));
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
	timeout.unref?.();
	try {
		await assertCodexModelSupportsImage({
			client,
			model,
			timeoutMs,
			signal: abortController.signal
		});
		const thread = assertCodexThreadStartResponse(await client.request("thread/start", {
			model,
			modelProvider: "openai",
			cwd: req.agentDir || process.cwd(),
			approvalPolicy: "on-request",
			sandbox: "read-only",
			serviceName: "OpenClaw",
			developerInstructions: "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
			dynamicTools: [],
			experimentalRawEvents: true,
			persistExtendedHistory: false,
			ephemeral: true
		}, {
			timeoutMs,
			signal: abortController.signal
		}));
		const collector = createCodexImageTurnCollector(thread.thread.id);
		const cleanup = client.addNotificationHandler(collector.handleNotification);
		const requestCleanup = client.addRequestHandler(denyCodexImageApprovalRequest);
		try {
			const turn = assertCodexTurnStartResponse(await client.request("turn/start", {
				threadId: thread.thread.id,
				input: [{
					type: "text",
					text: buildCodexImagePrompt(req),
					text_elements: []
				}, ...req.images.map((image) => ({
					type: "image",
					url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`
				}))],
				cwd: req.agentDir || process.cwd(),
				approvalPolicy: "on-request",
				model,
				effort: "low"
			}, {
				timeoutMs,
				signal: abortController.signal
			}));
			return {
				text: await collector.collect(turn.turn, {
					timeoutMs,
					signal: abortController.signal
				}),
				model
			};
		} finally {
			requestCleanup();
			cleanup();
		}
	} finally {
		clearTimeout(timeout);
		if (ownsClient) client.close();
	}
}
function denyCodexImageApprovalRequest(request) {
	if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return {
		decision: "decline",
		reason: "OpenClaw Codex image understanding does not grant tool or file approvals."
	};
	if (request.method === "item/permissions/requestApproval") return {
		permissions: {},
		scope: "turn"
	};
	if (request.method.includes("requestApproval")) return {
		decision: "decline",
		reason: "OpenClaw Codex image understanding does not grant native approvals."
	};
	if (request.method === "mcpServer/elicitation/request") return { action: "decline" };
}
async function assertCodexModelSupportsImage(params) {
	const match = readModelListResult(await params.client.request("model/list", {
		limit: 100,
		cursor: null,
		includeHidden: false
	}, {
		timeoutMs: Math.min(params.timeoutMs, 5e3),
		signal: params.signal
	})).models.find((entry) => entry.model === params.model || entry.id === params.model);
	if (!match) throw new Error(`Codex app-server model not found: ${params.model}`);
	if (!match.inputModalities.includes("image")) throw new Error(`Codex app-server model does not support images: ${params.model}`);
}
function buildCodexImagePrompt(req) {
	const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
	if (req.images.length <= 1) return prompt;
	return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}
function createCodexImageTurnCollector(threadId) {
	let turnId;
	let completedTurn;
	let promptError;
	const pending = [];
	const assistantTextByItem = /* @__PURE__ */ new Map();
	const assistantItemOrder = [];
	let resolveCompletion;
	const completion = new Promise((resolve) => {
		resolveCompletion = resolve;
	});
	const rememberAssistantText = (itemId, text) => {
		if (!text) return;
		if (!assistantTextByItem.has(itemId)) assistantItemOrder.push(itemId);
		assistantTextByItem.set(itemId, text);
	};
	const handleNotification = (notification) => {
		const params = isJsonObject(notification.params) ? notification.params : void 0;
		if (!params || readString(params, "threadId") !== threadId) return;
		if (!turnId) {
			pending.push(notification);
			return;
		}
		if (readNotificationTurnId(params) !== turnId) return;
		if (notification.method === "item/agentMessage/delta") {
			const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
			const delta = readString(params, "delta") ?? "";
			rememberAssistantText(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
			return;
		}
		if (notification.method === "turn/completed") {
			completedTurn = readCodexTurnCompletedNotification(notification.params)?.turn ?? completedTurn;
			resolveCompletion?.();
			return;
		}
		if (notification.method === "error") {
			promptError = readCodexErrorNotification(notification.params)?.error.message ?? "codex app-server image turn failed";
			resolveCompletion?.();
		}
	};
	return {
		handleNotification,
		async collect(startedTurn, options) {
			turnId = startedTurn.id;
			if (isTerminalTurn(startedTurn)) completedTurn = startedTurn;
			for (const notification of pending.splice(0)) handleNotification(notification);
			if (!completedTurn && !promptError) await waitForTurnCompletion({
				completion,
				timeoutMs: options.timeoutMs,
				signal: options.signal
			});
			if (promptError) throw new Error(promptError);
			if (completedTurn?.status === "failed") throw new Error(completedTurn.error?.message ?? "codex app-server image turn failed");
			const itemText = collectAssistantTextFromItems(completedTurn?.items);
			const deltaText = assistantItemOrder.map((itemId) => assistantTextByItem.get(itemId)?.trim()).filter((text) => Boolean(text)).join("\n\n").trim();
			const text = (itemText || deltaText).trim();
			if (!text) throw new Error("Codex app-server image turn returned no text.");
			return text;
		}
	};
}
async function waitForTurnCompletion(params) {
	let timeout;
	let cleanupAbort;
	try {
		await Promise.race([params.completion, new Promise((_, reject) => {
			timeout = setTimeout(() => reject(/* @__PURE__ */ new Error("codex app-server image turn timed out")), params.timeoutMs);
			timeout.unref?.();
			const abortListener = () => reject(/* @__PURE__ */ new Error("codex app-server image turn aborted"));
			params.signal.addEventListener("abort", abortListener, { once: true });
			cleanupAbort = () => params.signal.removeEventListener("abort", abortListener);
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
		cleanupAbort?.();
	}
}
function collectAssistantTextFromItems(items) {
	return (items ?? []).filter((item) => item.type === "agentMessage").map((item) => item.text.trim()).filter(Boolean).join("\n\n").trim();
}
function readNotificationTurnId(record) {
	const direct = readString(record, "turnId");
	if (direct) return direct;
	return isJsonObject(record.turn) ? readString(record.turn, "id") : void 0;
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" ? value : void 0;
}
function isTerminalTurn(turn) {
	return turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed";
}
//#endregion
export { buildCodexMediaUnderstandingProvider as t };
