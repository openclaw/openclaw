import { a as OPENCLAW_RUNTIME_CONTEXT_NOTICE, i as OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, o as OPENCLAW_RUNTIME_EVENT_HEADER, r as OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER } from "./internal-runtime-context-DWxvZFcB.js";
//#region src/agents/pi-embedded-runner/run/runtime-context-prompt.ts
const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";
function buildCurrentInboundPromptContextPrefix(context) {
	return context?.text.trim() ?? "";
}
function buildCurrentInboundPrompt(params) {
	const prefix = buildCurrentInboundPromptContextPrefix(params.context);
	if (!prefix) return params.prompt;
	if (!params.prompt) return prefix;
	return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}
function removeLastPromptOccurrence(text, prompt) {
	const index = text.lastIndexOf(prompt);
	if (index === -1) return null;
	return [text.slice(0, index).trimEnd(), text.slice(index + prompt.length).trimStart()].filter((part) => part.length > 0).join("\n\n").trim();
}
function resolveRuntimeContextPromptParts(params) {
	const transcriptPrompt = params.transcriptPrompt;
	if (transcriptPrompt === void 0 || transcriptPrompt === params.effectivePrompt) return { prompt: params.effectivePrompt };
	const prompt = transcriptPrompt.trim();
	if (!prompt && params.emptyTranscriptMode === "model-prompt") return { prompt: params.effectivePrompt };
	const runtimeContext = removeLastPromptOccurrence(params.effectivePrompt, transcriptPrompt)?.trim() || params.effectivePrompt.trim();
	if (!prompt) return runtimeContext ? {
		prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
		runtimeContext,
		runtimeOnly: true,
		runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext)
	} : { prompt: "" };
	return runtimeContext ? {
		prompt,
		runtimeContext
	} : { prompt };
}
function buildRuntimeContextMessageContent(params) {
	return [
		params.kind === "runtime-event" ? OPENCLAW_RUNTIME_EVENT_HEADER : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
		OPENCLAW_RUNTIME_CONTEXT_NOTICE,
		"",
		params.runtimeContext
	].join("\n");
}
function buildRuntimeContextSystemContext(runtimeContext) {
	return buildRuntimeContextMessageContent({
		runtimeContext,
		kind: "next-turn"
	});
}
function buildRuntimeEventSystemContext(runtimeContext) {
	return buildRuntimeContextMessageContent({
		runtimeContext,
		kind: "runtime-event"
	});
}
async function queueRuntimeContextForNextTurn(params) {
	const runtimeContext = params.runtimeContext?.trim();
	if (!runtimeContext) return;
	await params.session.sendCustomMessage({
		customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
		content: runtimeContext,
		display: false,
		details: { source: "openclaw-runtime-context" }
	}, { deliverAs: "nextTurn" });
}
//#endregion
export { queueRuntimeContextForNextTurn as a, buildRuntimeEventSystemContext as i, buildCurrentInboundPromptContextPrefix as n, resolveRuntimeContextPromptParts as o, buildRuntimeContextSystemContext as r, buildCurrentInboundPrompt as t };
