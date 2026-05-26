import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { b as resolveModelRefFromString, i as buildModelAliasIndex } from "./model-selection-shared-Dh1KrVmr.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { t as requireApiKey } from "./model-auth-runtime-shared-wzqc0OTs.js";
import { r as getApiKeyForModel } from "./model-auth-_bXIM30P.js";
import "./tts-config-XE0ggcbS.js";
import "./provider-registry-CvN-bC19.js";
import "./directives-Q0ObCrt8.js";
import { n as resolveModelAsync } from "./model-DaF1lz5m.js";
import { t as prepareModelForSimpleCompletion } from "./simple-completion-transport-DZ3kmRZl.js";
import { completeSimple } from "@earendil-works/pi-ai";
//#region src/tts/tts-core.ts
function resolveDefaultSummarizeTextDeps() {
	return {
		completeSimple,
		getApiKeyForModel,
		prepareModelForSimpleCompletion,
		requireApiKey,
		resolveModelAsync
	};
}
function resolveSummaryModelRef(cfg, config) {
	const defaultRef = resolveDefaultModelForAgent({ cfg });
	const override = normalizeOptionalString(config.summaryModel);
	if (!override) return {
		ref: defaultRef,
		source: "default"
	};
	const aliasIndex = buildModelAliasIndex({
		cfg,
		defaultProvider: defaultRef.provider
	});
	const resolved = resolveModelRefFromString({
		raw: override,
		defaultProvider: defaultRef.provider,
		aliasIndex
	});
	if (!resolved) return {
		ref: defaultRef,
		source: "default"
	};
	return {
		ref: resolved.ref,
		source: "summaryModel"
	};
}
function isTextContentBlock(block) {
	return block.type === "text";
}
async function summarizeText(params, deps = resolveDefaultSummarizeTextDeps()) {
	const { text, targetLength, cfg, config, timeoutMs } = params;
	if (targetLength < 100 || targetLength > 1e4) throw new Error(`Invalid targetLength: ${targetLength}`);
	const startTime = Date.now();
	const { ref } = resolveSummaryModelRef(cfg, config);
	const resolved = await deps.resolveModelAsync(ref.provider, ref.model, void 0, cfg);
	if (!resolved.model) throw new Error(resolved.error ?? `Unknown summary model: ${ref.provider}/${ref.model}`);
	const completionModel = deps.prepareModelForSimpleCompletion({
		model: resolved.model,
		cfg
	});
	const apiKey = deps.requireApiKey(await deps.getApiKeyForModel({
		model: completionModel,
		cfg
	}), ref.provider);
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const summary = (await deps.completeSimple(completionModel, { messages: [{
				role: "user",
				content: `You are an assistant that summarizes texts concisely while keeping the most important information. Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. Reply only with the summary, without additional explanations.\n\n<text_to_summarize>\n${text}\n</text_to_summarize>`,
				timestamp: Date.now()
			}] }, {
				apiKey,
				maxTokens: Math.ceil(targetLength / 2),
				temperature: .3,
				signal: controller.signal
			})).content.filter(isTextContentBlock).map((block) => block.text.trim()).filter(Boolean).join(" ").trim();
			if (!summary) throw new Error("No summary returned");
			return {
				summary,
				latencyMs: Date.now() - startTime,
				inputLength: text.length,
				outputLength: summary.length
			};
		} finally {
			clearTimeout(timeout);
		}
	} catch (err) {
		if (err.name === "AbortError") throw new Error("Summarization timed out", { cause: err });
		throw err;
	}
}
//#endregion
export { summarizeText as t };
