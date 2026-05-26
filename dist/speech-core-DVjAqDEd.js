import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { n as requireApiKey } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { i as getApiKeyForModel } from "./model-auth-Db-JGIrg.js";
import "./tts-config-WOpwhkHq.js";
import "./provider-http-errors-C90BH-le.js";
import "./provider-registry-mISFpr4F.js";
import "./directives-DiYOXJC0.js";
import { n as resolveModelAsync } from "./model-cgt_Zkgh.js";
import { t as prepareModelForSimpleCompletion } from "./simple-completion-transport-DXMrBFJR.js";
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
