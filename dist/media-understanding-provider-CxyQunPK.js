import { t as validateJsonSchemaValue } from "./schema-validator-CoHaB3Uu.js";
import "./json-schema-runtime-CiJf509Z.js";
import { i as FALLBACK_CODEX_MODELS, r as CODEX_PROVIDER_ID } from "./provider-catalog-DBnUa2-J.js";
import { l as resolveCodexAppServerRuntimeOptions } from "./config-CRe1vCzw.js";
import { i as assertCodexTurnStartResponse, l as readCodexTurnCompletedNotification, o as readCodexErrorNotification, r as assertCodexThreadStartResponse } from "./protocol-validators-_gKDcd0x.js";
import { r as readModelListResult } from "./models-SwFVvMcz.js";
import { t as isJsonObject } from "./protocol-oeJQu4rs.js";
import { n as buildCodexRuntimeThreadConfig } from "./thread-lifecycle-ICclp34e.js";
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
		describeImages: async (req) => describeCodexImages(req, options),
		extractStructured: async (req) => extractCodexStructured(req, options)
	};
}
async function describeCodexImages(req, options) {
	const model = req.model.trim();
	if (!model) throw new Error("Codex image understanding requires model id.");
	return {
		text: await runBoundedCodexVisionTurn({
			model,
			profile: req.profile,
			timeoutMs: req.timeoutMs,
			agentDir: req.agentDir,
			options,
			taskLabel: "image understanding",
			developerInstructions: "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
			input: [{
				type: "text",
				text: buildCodexImagePrompt(req),
				text_elements: []
			}, ...req.images.map((image) => ({
				type: "image",
				url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`
			}))],
			requiredModalities: ["text", "image"]
		}),
		model
	};
}
async function runBoundedCodexVisionTurn(params) {
	const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.options.pluginConfig });
	const timeoutMs = Math.max(100, params.timeoutMs);
	const ownsClient = !params.options.clientFactory;
	const client = params.options.clientFactory ? await params.options.clientFactory(appServer.start, params.profile) : await import("./shared-client-DUjDL6O1.js").then(({ createIsolatedCodexAppServerClient }) => createIsolatedCodexAppServerClient({
		startOptions: appServer.start,
		timeoutMs,
		authProfileId: params.profile
	}));
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
	timeout.unref?.();
	try {
		await assertCodexModelSupportsInput({
			client,
			model: params.model,
			requiredModalities: params.requiredModalities,
			timeoutMs,
			signal: abortController.signal
		});
		const thread = assertCodexThreadStartResponse(await client.request("thread/start", {
			model: params.model,
			modelProvider: "openai",
			cwd: params.agentDir || process.cwd(),
			approvalPolicy: "on-request",
			sandbox: "read-only",
			serviceName: "OpenClaw",
			developerInstructions: params.developerInstructions,
			config: buildCodexRuntimeThreadConfig(void 0, { nativeCodeModeEnabled: false }),
			environments: [],
			dynamicTools: [],
			experimentalRawEvents: true,
			persistExtendedHistory: false,
			ephemeral: true
		}, {
			timeoutMs,
			signal: abortController.signal
		}));
		const collector = createCodexTurnCollector(thread.thread.id, params.taskLabel);
		const cleanup = client.addNotificationHandler(collector.handleNotification);
		const requestCleanup = client.addRequestHandler(denyCodexImageApprovalRequest);
		try {
			const turn = assertCodexTurnStartResponse(await client.request("turn/start", {
				threadId: thread.thread.id,
				input: params.input,
				cwd: params.agentDir || process.cwd(),
				approvalPolicy: "on-request",
				model: params.model,
				effort: "low"
			}, {
				timeoutMs,
				signal: abortController.signal
			}));
			return await collector.collect(turn.turn, {
				timeoutMs,
				signal: abortController.signal
			});
		} finally {
			requestCleanup();
			cleanup();
		}
	} finally {
		clearTimeout(timeout);
		if (ownsClient) client.close();
	}
}
async function extractCodexStructured(req, options) {
	const model = req.model.trim();
	if (!model) throw new Error("Codex structured extraction requires model id.");
	if (!req.instructions.trim()) throw new Error("Codex structured extraction requires instructions.");
	if (req.input.length === 0) throw new Error("Codex structured extraction requires at least one input.");
	if (!req.input.some((entry) => entry.type === "image")) throw new Error("Codex structured extraction requires at least one image input.");
	return normalizeStructuredExtractionResult({
		text: await runBoundedCodexVisionTurn({
			model,
			profile: req.profile,
			timeoutMs: req.timeoutMs,
			agentDir: req.agentDir,
			options,
			taskLabel: "structured extraction",
			developerInstructions: "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
			input: buildCodexStructuredInput(req),
			requiredModalities: requiredStructuredModalities()
		}),
		model,
		provider: req.provider,
		req
	});
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
async function assertCodexModelSupportsInput(params) {
	const match = readModelListResult(await params.client.request("model/list", {
		limit: 100,
		cursor: null,
		includeHidden: false
	}, {
		timeoutMs: Math.min(params.timeoutMs, 5e3),
		signal: params.signal
	})).models.find((entry) => entry.model === params.model || entry.id === params.model);
	if (!match) throw new Error(`Codex app-server model not found: ${params.model}`);
	if (params.requiredModalities.includes("image") && !match.inputModalities.includes("image")) throw new Error(`Codex app-server model does not support images: ${params.model}`);
	if (params.requiredModalities.includes("text") && !match.inputModalities.includes("text")) throw new Error(`Codex app-server model does not support text: ${params.model}`);
}
function buildCodexImagePrompt(req) {
	const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
	if (req.images.length <= 1) return prompt;
	return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}
function requiredStructuredModalities() {
	return ["text", "image"];
}
function buildCodexStructuredInput(req) {
	return [{
		type: "text",
		text: buildStructuredExtractionPrompt(req),
		text_elements: []
	}, ...req.input.map((entry) => {
		if (entry.type === "text") return {
			type: "text",
			text: entry.text,
			text_elements: []
		};
		return {
			type: "image",
			url: `data:${entry.mime ?? "image/png"};base64,${entry.buffer.toString("base64")}`
		};
	})];
}
function buildStructuredExtractionPrompt(req) {
	return [
		req.instructions.trim(),
		req.schemaName ? `Schema name: ${req.schemaName}` : void 0,
		req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : void 0,
		req.jsonMode === false ? "Return the extraction as concise text." : "Return valid JSON only. Do not wrap the JSON in Markdown fences."
	].filter((part) => Boolean(part)).join("\n\n");
}
function isJsonSchemaObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeStructuredExtractionResult(params) {
	const result = {
		text: params.text,
		model: params.model,
		provider: params.provider,
		contentType: params.req.jsonMode === false ? "text" : "json"
	};
	if (params.req.jsonMode !== false) {
		try {
			result.parsed = JSON.parse(params.text);
		} catch {
			throw new Error("Codex structured extraction returned invalid JSON.");
		}
		if (isJsonSchemaObject(params.req.jsonSchema)) {
			const validation = validateJsonSchemaValue({
				schema: params.req.jsonSchema,
				cacheKey: "codex.media-understanding.extractStructured",
				value: result.parsed,
				cache: false
			});
			if (!validation.ok) {
				const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
				throw new Error(`Codex structured extraction JSON did not match schema: ${message}`);
			}
			result.parsed = validation.value;
		}
	}
	return result;
}
function createCodexTurnCollector(threadId, taskLabel) {
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
			promptError = readCodexErrorNotification(notification.params)?.error.message ?? `codex app-server ${taskLabel} turn failed`;
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
				signal: options.signal,
				taskLabel
			});
			if (promptError) throw new Error(promptError);
			if (completedTurn?.status === "failed") throw new Error(completedTurn.error?.message ?? `codex app-server ${taskLabel} turn failed`);
			const itemText = collectAssistantTextFromItems(completedTurn?.items);
			const deltaText = assistantItemOrder.map((itemId) => assistantTextByItem.get(itemId)?.trim()).filter((text) => Boolean(text)).join("\n\n").trim();
			const text = (itemText || deltaText).trim();
			if (!text) throw new Error(`Codex app-server ${taskLabel} turn returned no text.`);
			return text;
		}
	};
}
async function waitForTurnCompletion(params) {
	let timeout;
	let cleanupAbort;
	try {
		await Promise.race([params.completion, new Promise((_, reject) => {
			timeout = setTimeout(() => reject(/* @__PURE__ */ new Error(`codex app-server ${params.taskLabel} turn timed out`)), params.timeoutMs);
			timeout.unref?.();
			const abortListener = () => reject(/* @__PURE__ */ new Error(`codex app-server ${params.taskLabel} turn aborted`));
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
