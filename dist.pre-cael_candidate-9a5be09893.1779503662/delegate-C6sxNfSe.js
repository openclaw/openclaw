import { t as buildMemoryPromptSection } from "./memory-state-DKjCVvl8.js";
import { n as normalizeStructuredPromptSection } from "./prompt-cache-stability-B_6GljRB.js";
//#region src/context-engine/delegate.ts
let compactRuntimePromise = null;
function loadCompactRuntime() {
	compactRuntimePromise ??= import("./compact.runtime.js");
	return compactRuntimePromise;
}
/**
* Delegate a context-engine compaction request to OpenClaw's built-in runtime compaction path.
*
* This is the same bridge used by the legacy context engine. Third-party
* engines can call it from their own `compact()` implementations when they do
* not own the compaction algorithm but still need `/compact` and overflow
* recovery to use the stock runtime behavior.
*
* Note: `compactionTarget` is part of the public `compact()` contract, but the
* built-in runtime compaction path does not expose that knob. This helper
* ignores it to preserve legacy behavior; engines that need target-specific
* compaction should implement their own `compact()` algorithm.
*/
async function delegateCompactionToRuntime(params) {
	const { compactEmbeddedPiSessionDirect } = await loadCompactRuntime();
	const runtimeContext = params.runtimeContext ?? {};
	const currentTokenCount = params.currentTokenCount ?? (typeof runtimeContext.currentTokenCount === "number" && Number.isFinite(runtimeContext.currentTokenCount) && runtimeContext.currentTokenCount > 0 ? Math.floor(runtimeContext.currentTokenCount) : void 0);
	const result = await compactEmbeddedPiSessionDirect({
		...runtimeContext,
		sessionId: params.sessionId,
		sessionFile: params.sessionFile,
		tokenBudget: params.tokenBudget,
		...currentTokenCount !== void 0 ? { currentTokenCount } : {},
		force: params.force,
		customInstructions: params.customInstructions,
		workspaceDir: typeof runtimeContext.workspaceDir === "string" ? runtimeContext.workspaceDir : process.cwd()
	});
	return {
		ok: result.ok,
		compacted: result.compacted,
		reason: result.reason,
		result: result.result ? {
			summary: result.result.summary,
			firstKeptEntryId: result.result.firstKeptEntryId,
			tokensBefore: result.result.tokensBefore,
			tokensAfter: result.result.tokensAfter,
			details: result.result.details,
			sessionId: result.result.sessionId,
			sessionFile: result.result.sessionFile
		} : void 0
	};
}
/**
* Build a context-engine-ready systemPromptAddition from the active memory
* plugin prompt path. This lets non-legacy engines explicitly opt into the
* same memory/wiki guidance that the legacy engine gets via system prompt
* assembly, without reimplementing memory prompt formatting.
*/
function buildMemorySystemPromptAddition(params) {
	const lines = buildMemoryPromptSection({
		availableTools: params.availableTools,
		citationsMode: params.citationsMode
	});
	if (lines.length === 0) return;
	return normalizeStructuredPromptSection(lines.join("\n")) || void 0;
}
//#endregion
export { delegateCompactionToRuntime as n, buildMemorySystemPromptAddition as t };
