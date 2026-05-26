import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { n as extractAssistantText } from "./pi-embedded-utils-D6gJe2Np.js";
import { r as prepareSimpleCompletionModelForAgent, t as completeWithPreparedSimpleCompletionModel } from "./simple-completion-runtime-IPeECaJX.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
//#region src/crestodian/assistant-backends.ts
const CRESTODIAN_CLAUDE_CLI_MODEL = "claude-opus-4-7";
const CRESTODIAN_CODEX_MODEL = "gpt-5.5";
const CLAUDE_CLI_BACKEND = {
	kind: "claude-cli",
	label: `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`,
	runner: "cli",
	provider: "claude-cli",
	model: CRESTODIAN_CLAUDE_CLI_MODEL,
	buildConfig: (workspaceDir) => buildCliPlannerConfig(workspaceDir, `claude-cli/${CRESTODIAN_CLAUDE_CLI_MODEL}`)
};
const CODEX_APP_SERVER_BACKEND = {
	kind: "codex-app-server",
	label: `openai/${CRESTODIAN_CODEX_MODEL} via codex`,
	runner: "embedded",
	provider: "openai",
	model: CRESTODIAN_CODEX_MODEL,
	buildConfig: buildCodexAppServerPlannerConfig
};
function selectCrestodianLocalPlannerBackends(overview) {
	const backends = [];
	if (overview.tools.claude.found) backends.push(CLAUDE_CLI_BACKEND);
	if (overview.tools.codex.found) backends.push(CODEX_APP_SERVER_BACKEND);
	return backends;
}
function buildCliPlannerConfig(workspaceDir, modelRef) {
	return { agents: { defaults: {
		workspace: workspaceDir,
		model: { primary: modelRef }
	} } };
}
function buildCodexAppServerPlannerConfig(workspaceDir) {
	return {
		agents: { defaults: {
			workspace: workspaceDir,
			model: { primary: `openai/${CRESTODIAN_CODEX_MODEL}` }
		} },
		plugins: { entries: { codex: { enabled: true } } }
	};
}
//#endregion
//#region src/crestodian/assistant-prompts.ts
const CRESTODIAN_ASSISTANT_TIMEOUT_MS = 1e4;
const CRESTODIAN_ASSISTANT_SYSTEM_PROMPT = [
	"You are Crestodian, OpenClaw's ring-zero setup helper.",
	"Turn the user's request into exactly one safe OpenClaw Crestodian command.",
	"Return only compact JSON with keys reply and command.",
	"Do not invent commands. Do not claim a write was applied.",
	"Do not use tools, shell commands, file edits, or network lookups; plan only from the supplied overview.",
	"Use the provided OpenClaw docs/source references when the user's request needs behavior, config, or architecture details.",
	"If local source is available, prefer inspecting it. Otherwise point to GitHub and strongly recommend reviewing source when docs are not enough.",
	"Allowed commands:",
	"- setup",
	"- status",
	"- health",
	"- doctor",
	"- doctor fix",
	"- gateway status",
	"- restart gateway",
	"- start gateway",
	"- stop gateway",
	"- agents",
	"- models",
	"- plugins list",
	"- plugins search <query>",
	"- plugin install <npm-or-clawhub-spec>",
	"- plugin uninstall <id>",
	"- audit",
	"- validate config",
	"- set default model <provider/model>",
	"- config set <path> <value>",
	"- config set-ref <path> env <ENV_VAR>",
	"- create agent <id> workspace <path> model <provider/model>",
	"- talk to <id> agent",
	"- talk to agent",
	"If unsure, choose overview."
].join("\n");
function buildCrestodianAssistantUserPrompt(params) {
	const agents = params.overview.agents.map((agent) => {
		return `- ${[
			`id=${agent.id}`,
			agent.name ? `name=${agent.name}` : void 0,
			agent.workspace ? `workspace=${agent.workspace}` : void 0,
			agent.model ? `model=${agent.model}` : void 0,
			agent.isDefault ? "default=true" : void 0
		].filter(Boolean).join(", ")}`;
	}).join("\n");
	return [
		`User request: ${params.input}`,
		"",
		`Default agent: ${params.overview.defaultAgentId}`,
		`Default model: ${params.overview.defaultModel ?? "not configured"}`,
		`Config valid: ${params.overview.config.valid}`,
		`Gateway reachable: ${params.overview.gateway.reachable}`,
		`Codex binary: ${params.overview.tools.codex.found ? "found" : "not found"}`,
		`Claude Code CLI: ${params.overview.tools.claude.found ? "found" : "not found"}`,
		`OpenAI API key: ${params.overview.tools.apiKeys.openai ? "found" : "not found"}`,
		`Anthropic API key: ${params.overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
		`OpenClaw docs: ${params.overview.references.docsPath ?? params.overview.references.docsUrl}`,
		`OpenClaw source: ${params.overview.references.sourcePath ?? params.overview.references.sourceUrl}`,
		params.overview.references.sourcePath ? "Source mode: local git checkout; inspect source directly when docs are insufficient." : "Source mode: package/install; use GitHub source when docs are insufficient.",
		"",
		"Agents:",
		agents || "- none"
	].join("\n");
}
function parseCrestodianAssistantPlanText(rawText) {
	const text = rawText?.trim();
	if (!text) return null;
	const jsonText = extractFirstJsonObject(text);
	if (!jsonText) return null;
	let parsed;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed;
	const command = typeof record.command === "string" ? record.command.trim() : "";
	if (!command) return null;
	const reply = typeof record.reply === "string" ? record.reply.trim() : void 0;
	return {
		command,
		...reply ? { reply } : {}
	};
}
function extractFirstJsonObject(text) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	return text.slice(start, end + 1);
}
//#endregion
//#region src/crestodian/assistant.ts
async function planCrestodianCommand(params) {
	const configured = await planCrestodianCommandWithConfiguredModel(params);
	if (configured) return configured;
	return await planCrestodianCommandWithLocalRuntime(params);
}
async function planCrestodianCommandWithConfiguredModel(params) {
	const input = params.input.trim();
	if (!input) return null;
	const snapshot = await (params.deps?.readConfigFileSnapshot ?? readConfigFileSnapshot)();
	if (!snapshot.exists || !snapshot.valid) return null;
	const cfg = snapshot.runtimeConfig ?? snapshot.config;
	const agentId = resolveDefaultAgentId(cfg);
	const prepared = await (params.deps?.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent)({
		cfg,
		agentId,
		allowMissingApiKeyModes: ["aws-sdk"]
	});
	if ("error" in prepared) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CRESTODIAN_ASSISTANT_TIMEOUT_MS);
	try {
		const parsed = parseCrestodianAssistantPlanText(extractAssistantText(await (params.deps?.completeWithPreparedSimpleCompletionModel ?? completeWithPreparedSimpleCompletionModel)({
			model: prepared.model,
			auth: prepared.auth,
			context: {
				systemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
				messages: [{
					role: "user",
					content: buildCrestodianAssistantUserPrompt({
						input,
						overview: params.overview
					}),
					timestamp: Date.now()
				}]
			},
			options: {
				maxTokens: 512,
				signal: controller.signal
			}
		})));
		if (!parsed) return null;
		return {
			...parsed,
			modelLabel: `${prepared.selection.provider}/${prepared.selection.modelId}`
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
async function planCrestodianCommandWithLocalRuntime(params) {
	const input = params.input.trim();
	if (!input) return null;
	const backends = selectCrestodianLocalPlannerBackends(params.overview);
	if (backends.length === 0) return null;
	const prompt = buildCrestodianAssistantUserPrompt({
		input,
		overview: params.overview
	});
	for (const backend of backends) try {
		const parsed = parseCrestodianAssistantPlanText(await runLocalRuntimePlanner(backend, {
			prompt,
			deps: params.deps
		}));
		if (parsed) return {
			...parsed,
			modelLabel: backend.label
		};
	} catch {}
	return null;
}
async function runLocalRuntimePlanner(backend, params) {
	const tempDir = await (params.deps?.createTempDir ?? createTempPlannerDir)();
	try {
		const runId = `crestodian-planner-${randomUUID()}`;
		const sessionFile = path.join(tempDir, "session.jsonl");
		const sessionId = `${runId}-session`;
		const sessionKey = `temp:crestodian-planner:${runId}`;
		switch (backend.runner) {
			case "cli": return extractPlannerResultText(await (params.deps?.runCliAgent ?? await loadRunCliAgent())({
				sessionId,
				sessionKey,
				agentId: "crestodian",
				trigger: "manual",
				sessionFile,
				workspaceDir: tempDir,
				config: backend.buildConfig(tempDir),
				prompt: params.prompt,
				provider: backend.provider,
				model: backend.model,
				timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
				runId,
				extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
				extraSystemPromptStatic: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
				messageChannel: "crestodian",
				messageProvider: "crestodian",
				cleanupCliLiveSessionOnRunEnd: true
			}));
			case "embedded": return extractPlannerResultText(await (params.deps?.runEmbeddedPiAgent ?? await loadRunEmbeddedPiAgent())({
				sessionId,
				sessionKey,
				agentId: "crestodian",
				trigger: "manual",
				sessionFile,
				workspaceDir: tempDir,
				config: backend.buildConfig(tempDir),
				prompt: params.prompt,
				provider: backend.provider,
				model: backend.model,
				agentHarnessId: "codex",
				disableTools: true,
				toolsAllow: [],
				timeoutMs: CRESTODIAN_ASSISTANT_TIMEOUT_MS,
				runId,
				extraSystemPrompt: CRESTODIAN_ASSISTANT_SYSTEM_PROMPT,
				messageChannel: "crestodian",
				messageProvider: "crestodian",
				cleanupBundleMcpOnRunEnd: true
			}));
		}
		return;
	} finally {
		await (params.deps?.removeTempDir ?? removeTempPlannerDir)(tempDir);
	}
}
async function createTempPlannerDir() {
	return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-crestodian-planner-"));
}
async function removeTempPlannerDir(dir) {
	await fs.rm(dir, {
		recursive: true,
		force: true
	});
}
async function loadRunCliAgent() {
	return (await import("./cli-runner-DZv4K6u9.js")).runCliAgent;
}
async function loadRunEmbeddedPiAgent() {
	return (await import("./pi-embedded-DZrk-PV0.js")).runEmbeddedPiAgent;
}
function extractPlannerResultText(result) {
	return result.meta?.finalAssistantVisibleText ?? result.meta?.finalAssistantRawText ?? result.payloads?.map((payload) => payload.text?.trim()).filter(Boolean).join("\n");
}
//#endregion
export { planCrestodianCommand };
