import { o as redactToolDetail } from "./redact-R2-EdHUS.js";
import "./errors-VfATXfah.js";
import { y as truncateUtf16Safe } from "./utils-CRkrr5e6.js";
import "./version-BHBlW4Qb.js";
import "./agent-scope-CrHjLKeQ.js";
import { t as createSubsystemLogger } from "./subsystem-DtPhzVBn.js";
import "./registry-CMelDO5r.js";
import { b as listCodexAppServerExtensionFactories } from "./loader-D2bM1RDY.js";
import { c as joinPresentTextSegments, t as getGlobalHookRunner } from "./hook-runner-global-DXf4X1LM.js";
import "./session-write-lock-B6MaXn5r.js";
import "./transcript-Cnh_OUdm.js";
import "./model-auth-BAukXI7p.js";
import { d as queueEmbeddedPiMessageWithOutcome } from "./runs-YRsDmGSB.js";
import { a as buildAgentHookContext } from "./lifecycle-hook-helpers-DKjItj2_.js";
import "./bootstrap-files-DZP2065R.js";
import "./pi-tools.before-tool-call-DfEuKG6T.js";
import "./tool-result-middleware-BA32n_2S.js";
import "./heartbeat-tool-response-DgsP50jw.js";
import "./attempt.tool-run-context-C7yBZV4P.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-DLH-VNgc.js";
import "./channel-streaming-CNUJHcC-.js";
import "./logger-CXZYJfp6.js";
import "./gateway-qIsFO8WH.js";
import "./nodes-utils-qTYmxRK2.js";
import "./provider-auth-CYiv4Uvo.js";
import "./sandbox-WuqtRIGw.js";
import "./result-fallback-classifier-CKu8gxpG.js";
import "./build-CMYIlLj9.js";
import "./native-hook-relay-COhaq90u.js";
//#region src/agents/harness/prompt-compaction-hook-helpers.ts
const log$1 = createSubsystemLogger("agents/harness");
async function resolveAgentHarnessBeforePromptBuildResult(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_prompt_build") && !hookRunner?.hasHooks("before_agent_start")) return {
		prompt: params.prompt,
		developerInstructions: params.developerInstructions
	};
	const hookCtx = buildAgentHookContext(params.ctx);
	const promptEvent = {
		prompt: params.prompt,
		messages: params.messages
	};
	const promptBuildResult = hookRunner.hasHooks("before_prompt_build") ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error) => {
		log$1.warn(`before_prompt_build hook failed: ${String(error)}`);
	}) : void 0;
	const legacyResult = hookRunner.hasHooks("before_agent_start") ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error) => {
		log$1.warn(`before_agent_start hook (legacy prompt build path) failed: ${String(error)}`);
	}) : void 0;
	const systemPrompt = resolvePromptBuildSystemPrompt({
		developerInstructions: params.developerInstructions,
		promptBuildResult,
		legacyResult
	});
	return {
		prompt: joinPresentTextSegments([
			promptBuildResult?.prependContext,
			legacyResult?.prependContext,
			params.prompt
		]) ?? params.prompt,
		developerInstructions: joinPresentTextSegments([
			promptBuildResult?.prependSystemContext,
			legacyResult?.prependSystemContext,
			systemPrompt,
			promptBuildResult?.appendSystemContext,
			legacyResult?.appendSystemContext
		]) ?? systemPrompt
	};
}
function resolvePromptBuildSystemPrompt(params) {
	if (typeof params.promptBuildResult?.systemPrompt === "string") return params.promptBuildResult.systemPrompt;
	if (typeof params.legacyResult?.systemPrompt === "string") return params.legacyResult.systemPrompt;
	return params.developerInstructions;
}
async function runAgentHarnessBeforeCompactionHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("before_compaction")) return;
	try {
		await hookRunner.runBeforeCompaction({
			messageCount: params.messages.length,
			messages: params.messages,
			sessionFile: params.sessionFile
		}, buildAgentHookContext(params.ctx));
	} catch (error) {
		log$1.warn(`before_compaction hook failed: ${String(error)}`);
	}
}
async function runAgentHarnessAfterCompactionHook(params) {
	const hookRunner = getGlobalHookRunner();
	if (!hookRunner?.hasHooks("after_compaction")) return;
	try {
		await hookRunner.runAfterCompaction({
			messageCount: params.messages.length,
			compactedCount: params.compactedCount,
			sessionFile: params.sessionFile
		}, buildAgentHookContext(params.ctx));
	} catch (error) {
		log$1.warn(`after_compaction hook failed: ${String(error)}`);
	}
}
//#endregion
//#region src/agents/harness/codex-app-server-extensions.ts
const log = createSubsystemLogger("agents/harness");
function createCodexAppServerToolResultExtensionRunner(ctx, factories = listCodexAppServerExtensionFactories()) {
	const handlers = [];
	const runtime = { on(event, handler) {
		if (event === "tool_result") handlers.push(handler);
	} };
	const initPromise = (async () => {
		for (const factory of factories) await factory(runtime);
	})();
	return { async applyToolResultExtensions(event) {
		await initPromise;
		let current = event.result;
		for (const handler of handlers) try {
			const next = await handler({
				...event,
				result: current
			}, ctx);
			if (next?.result) current = next.result;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			log.warn(`[codex] tool_result extension failed for ${event.toolName}: ${detail}`);
		}
		return current;
	} };
}
//#endregion
//#region src/plugin-sdk/agent-harness-runtime.ts
const TOOL_PROGRESS_OUTPUT_MAX_CHARS = 8e3;
/**
* @deprecated Active-run queueing is an internal runtime concern. Use current
* runtime hooks instead of steering a harness through this legacy boolean API.
*/
function queueAgentHarnessMessage(sessionId, text, options) {
	return queueEmbeddedPiMessageWithOutcome(sessionId, text, options).queued;
}
function inferToolMetaFromArgs(toolName, args, options) {
	return formatToolDetail(resolveToolDisplay({
		name: toolName,
		args,
		detailMode: options?.detailMode
	}));
}
/**
* Prepare verbose tool output for user-facing progress messages.
*/
function formatToolProgressOutput(output, options) {
	const trimmed = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!trimmed) return;
	const redacted = redactToolDetail(trimmed);
	const maxChars = options?.maxChars ?? 8e3;
	if (redacted.length <= maxChars) return redacted;
	return `${truncateUtf16Safe(redacted, maxChars)}\n...(truncated)...`;
}
/**
* Classify terminal harness turns that completed without assistant output that
* should advance fallback. Deliberate silent replies such as NO_REPLY count as
* intentional output, while whitespace-only text remains fallback-eligible.
* This is intentionally SDK-level so plugin harness adapters such as Codex
* preserve the same OpenClaw-owned fallback signals as the built-in PI path
* without re-implementing terminal-result policy.
*/
function classifyAgentHarnessTerminalOutcome(params) {
	if (!params.turnCompleted || params.promptError !== void 0 && params.promptError !== null || hasVisibleAssistantText(params.assistantTexts)) return;
	if (params.planText?.trim()) return "planning-only";
	if (params.reasoningText?.trim()) return "reasoning-only";
	return "empty";
}
function hasVisibleAssistantText(assistantTexts) {
	return assistantTexts.some((text) => text.trim().length > 0);
}
//#endregion
export { queueAgentHarnessMessage as a, runAgentHarnessAfterCompactionHook as c, inferToolMetaFromArgs as i, runAgentHarnessBeforeCompactionHook as l, classifyAgentHarnessTerminalOutcome as n, createCodexAppServerToolResultExtensionRunner as o, formatToolProgressOutput as r, resolveAgentHarnessBeforePromptBuildResult as s, TOOL_PROGRESS_OUTPUT_MAX_CHARS as t };
