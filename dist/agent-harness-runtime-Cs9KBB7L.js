import { o as redactToolDetail } from "./redact-R2-EdHUS.js";
import "./errors-VfATXfah.js";
import { y as truncateUtf16Safe } from "./utils-CKsuXgDI.js";
import "./version-B2G3zXnp.js";
import "./agent-scope-C1Fl7gAf.js";
import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import "./registry-481lFxWt.js";
import { x as listCodexAppServerExtensionFactories } from "./loader-DkTFEskE.js";
import { c as joinPresentTextSegments, t as getGlobalHookRunner } from "./hook-runner-global-aUo3QVZe.js";
import "./session-write-lock-BT1vMcpZ.js";
import "./transcript-D34ZH8ZQ.js";
import { d as queueEmbeddedPiMessageWithOutcome } from "./runs-CP7D8ODl.js";
import "./bootstrap-files-BUEAiWga.js";
import "./pi-tools.before-tool-call-BmZM4hyt.js";
import "./model-auth-_bXIM30P.js";
import "./tool-result-middleware-ecm3p4oK.js";
import "./heartbeat-tool-response-cTpOgQ69.js";
import "./attempt.tool-run-context-BuKiw0o1.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CzQN47mi.js";
import "./channel-streaming-BfXk-s2d.js";
import "./logger-8oA4pYXO.js";
import "./gateway-CdR1r1Su.js";
import "./nodes-utils-DT1n7Zjn.js";
import "./provider-auth-D5QGE8z6.js";
import "./sandbox-DIHI_0fY.js";
import "./result-fallback-classifier-CxOwFLYE.js";
import "./build-C9d6LjJn.js";
import { a as buildAgentHookContext } from "./lifecycle-hook-helpers-CmTFojZU.js";
import "./native-hook-relay-C47Deh81.js";
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
async function loadCodexBundleMcpThreadConfig(params) {
	const { loadCodexBundleMcpThreadConfig: load } = await import("./codex-mcp-config-Cx8PePfJ.js");
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
