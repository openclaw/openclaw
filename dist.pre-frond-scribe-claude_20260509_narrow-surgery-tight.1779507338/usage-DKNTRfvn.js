import { t as asFiniteNumber } from "./number-coercion-CgoBR0cm.js";
//#region src/agents/usage.ts
function makeZeroUsageSnapshot() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function hasNonzeroUsage(usage) {
	if (!usage) return false;
	return [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.reasoningTokens,
		usage.total
	].some((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}
const normalizeTokenCount = (value) => {
	const numeric = asFiniteNumber(value);
	if (numeric === void 0) return;
	if (numeric <= 0) return 0;
	return Math.min(Math.trunc(numeric), Number.MAX_SAFE_INTEGER);
};
function normalizeUsage(raw) {
	if (!raw) return;
	const cacheRead = normalizeTokenCount(raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens ?? raw.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens);
	const rawInputValue = raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens ?? raw.prompt_n ?? raw.timings?.prompt_n;
	const usesOpenAIStylePromptTotals = raw.cached_tokens !== void 0 || raw.input_tokens_details?.cached_tokens !== void 0 || raw.prompt_tokens_details?.cached_tokens !== void 0;
	const rawInput = asFiniteNumber(rawInputValue);
	const input = normalizeTokenCount(rawInput !== void 0 && usesOpenAIStylePromptTotals && cacheRead !== void 0 ? rawInput - cacheRead : rawInput);
	const output = normalizeTokenCount(raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens ?? raw.predicted_n ?? raw.timings?.predicted_n);
	const cacheWrite = normalizeTokenCount(raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens);
	const reasoningTokens = normalizeTokenCount(raw.reasoningTokens ?? raw.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens);
	const total = normalizeTokenCount(raw.total ?? raw.totalTokens ?? raw.total_tokens);
	if (input === void 0 && output === void 0 && cacheRead === void 0 && cacheWrite === void 0 && reasoningTokens === void 0 && total === void 0) return;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...reasoningTokens !== void 0 ? { reasoningTokens } : {},
		total
	};
}
/**
* Maps normalized usage to OpenAI Chat Completions `usage` fields.
*
* `prompt_tokens` is input + cacheRead (cache write is excluded to match the
* OpenAI-style breakdown used by the compat endpoint).
*
* `total_tokens` is the greater of the component sum and aggregate `total` when
* present, so a partial breakdown cannot discard a valid upstream total.
*/
function toOpenAiChatCompletionsUsage(usage) {
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const promptTokens = Math.max(0, input + cacheRead);
	const completionTokens = Math.max(0, output);
	const componentTotal = promptTokens + completionTokens;
	const aggregateRaw = usage?.total;
	const aggregateTotal = typeof aggregateRaw === "number" && Number.isFinite(aggregateRaw) ? Math.max(0, aggregateRaw) : void 0;
	const totalTokens = aggregateTotal !== void 0 ? Math.max(componentTotal, aggregateTotal) : componentTotal;
	const reasoningTokens = normalizeTokenCount(usage?.reasoningTokens);
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totalTokens,
		...reasoningTokens !== void 0 ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } } : {}
	};
}
function derivePromptTokens(usage) {
	if (!usage) return;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const sum = input + cacheRead + cacheWrite;
	return sum > 0 ? sum : void 0;
}
function deriveContextPromptTokens(params) {
	const promptOverride = params.promptTokens;
	if (typeof promptOverride === "number" && Number.isFinite(promptOverride) && promptOverride > 0) return promptOverride;
	return derivePromptTokens(params.lastCallUsage) ?? derivePromptTokens(params.usage);
}
function deriveSessionTotalTokens(params) {
	const promptOverride = params.promptTokens;
	const hasPromptOverride = typeof promptOverride === "number" && Number.isFinite(promptOverride) && promptOverride > 0;
	const usage = params.usage;
	if (!usage && !hasPromptOverride) return;
	const promptTokens = deriveContextPromptTokens({
		promptTokens: hasPromptOverride ? promptOverride : void 0,
		usage
	});
	if (!(typeof promptTokens === "number") || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
	return promptTokens;
}
//#endregion
export { makeZeroUsageSnapshot as a, hasNonzeroUsage as i, derivePromptTokens as n, normalizeUsage as o, deriveSessionTotalTokens as r, toOpenAiChatCompletionsUsage as s, deriveContextPromptTokens as t };
