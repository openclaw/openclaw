import { c as redactToolDetail } from "./redact-Dt7UuSgF.js";
import "./errors-D3K0qXmL.js";
import { y as truncateUtf16Safe } from "./utils-BlCbsks0.js";
import "./version-CQfgAE7_.js";
import "./agent-scope-Bl5pjInQ.js";
import { t as createSubsystemLogger } from "./subsystem-B30d2Pdj.js";
import "./registry-C5gpGLvV.js";
import { b as listCodexAppServerExtensionFactories } from "./loader-m7q4-54V.js";
import { c as joinPresentTextSegments, t as getGlobalHookRunner } from "./hook-runner-global-BTpCaQza.js";
import "./registry-B-mVXdYO.js";
import "./transcript-ChT1fc4-.js";
import "./session-write-lock-BfzCD55Q.js";
import "./model-auth-Cxwuuej8.js";
import { u as queueEmbeddedPiMessageWithOutcome } from "./runs-B_letAfx.js";
import "./heartbeat-tool-response-DyfNPUEq.js";
import "./bootstrap-files-BkmXzi3V.js";
import "./pi-tools.before-tool-call-28rCfk3u.js";
import "./gateway-CLvOhD7F.js";
import "./attempt.tool-run-context-CaLJRlhH.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-De1vKU0G.js";
import "./channel-streaming-COJvnRXu.js";
import "./logger-EZ6OokuK.js";
import "./nodes-utils-DsNDoiiL.js";
import "./sandbox-Cc4FV_Dy.js";
import "./context-engine-lifecycle-CQvKCDF3.js";
import "./result-fallback-classifier-DVVlFbrg.js";
import "./build-BMR1Ep0R.js";
import { a as buildAgentHookContext } from "./lifecycle-hook-helpers-w2DzZFhd.js";
import "./agent-dir-compat-9wvd193r.js";
import "./native-hook-relay-bz_H4P9v.js";
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
* @deprecated Active-run queueing is an internal runtime concern. This legacy
* boolean API only reports immediate queue eligibility and cannot observe async
* runtime rejection; runtime-owned delivery paths should use acceptance-aware
* steering instead of public SDK queueing.
*/
function queueAgentHarnessMessage(sessionId, text, options) {
	return queueEmbeddedPiMessageWithOutcome(sessionId, text, options).queued;
}
async function loadCodexBundleMcpThreadConfig(params) {
	const { loadCodexBundleMcpThreadConfig: load } = await import("./codex-mcp-config-Bi7LeNgW.js");
	return load(params);
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
export { loadCodexBundleMcpThreadConfig as a, resolveAgentHarnessBeforePromptBuildResult as c, inferToolMetaFromArgs as i, runAgentHarnessAfterCompactionHook as l, classifyAgentHarnessTerminalOutcome as n, queueAgentHarnessMessage as o, formatToolProgressOutput as r, createCodexAppServerToolResultExtensionRunner as s, TOOL_PROGRESS_OUTPUT_MAX_CHARS as t, runAgentHarnessBeforeCompactionHook as u };
