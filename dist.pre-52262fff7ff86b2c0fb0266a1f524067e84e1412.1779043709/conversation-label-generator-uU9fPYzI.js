import { r as logVerbose } from "./globals-CrpmxZTV.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DZrSRKB-.js";
import { n as requireApiKey } from "./model-auth-runtime-shared--Gu-BVM4.js";
import "./model-auth-CWuFZQFj.js";
import { n as resolveModelAsync } from "./model-BABWnO_m.js";
import { t as prepareModelForSimpleCompletion } from "./simple-completion-transport-CuuWPVMQ.js";
import { n as getRuntimeAuthForModel } from "./runtime-model-auth.runtime-AvC9-UqC.js";
import { completeSimple } from "@earendil-works/pi-ai";
//#region src/auto-reply/reply/conversation-label-generator.ts
const DEFAULT_MAX_LABEL_LENGTH = 128;
const TIMEOUT_MS = 15e3;
function isTextContentBlock(block) {
	return block.type === "text";
}
function isCodexSimpleCompletionModel(model) {
	return model.provider === "openai-codex" || model.api === "openai-codex-responses";
}
function extractSimpleCompletionError(result) {
	if (result.stopReason !== "error") return null;
	return result.errorMessage?.trim() || "unknown error";
}
async function generateConversationLabel(params) {
	const { userMessage, prompt, cfg, agentId, agentDir } = params;
	const maxLength = typeof params.maxLength === "number" && Number.isFinite(params.maxLength) && params.maxLength > 0 ? Math.floor(params.maxLength) : DEFAULT_MAX_LABEL_LENGTH;
	const modelRef = resolveDefaultModelForAgent({
		cfg,
		agentId
	});
	const resolved = await resolveModelAsync(modelRef.provider, modelRef.model, agentDir, cfg);
	if (!resolved.model) {
		logVerbose(`conversation-label-generator: failed to resolve model ${modelRef.provider}/${modelRef.model}`);
		return null;
	}
	const completionModel = prepareModelForSimpleCompletion({
		model: resolved.model,
		cfg
	});
	const apiKey = requireApiKey(await getRuntimeAuthForModel({
		model: completionModel,
		cfg,
		workspaceDir: agentDir
	}), modelRef.provider);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const result = await completeSimple(completionModel, {
			systemPrompt: prompt,
			messages: [{
				role: "user",
				content: userMessage,
				timestamp: Date.now()
			}]
		}, {
			apiKey,
			maxTokens: 100,
			...isCodexSimpleCompletionModel(completionModel) ? {} : { temperature: .3 },
			signal: controller.signal
		});
		const errorMessage = extractSimpleCompletionError(result);
		if (errorMessage) {
			logVerbose(`conversation-label-generator: completion failed: ${errorMessage}`);
			return null;
		}
		const text = result.content.filter(isTextContentBlock).map((block) => block.text).join("").trim();
		if (!text) return null;
		return text.slice(0, maxLength);
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
export { generateConversationLabel as t };
