import { d as resolveGatewayPort, s as resolveConfigPath } from "./paths-Cw7f9XhU.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { a as resolveAgentEffectiveModelPrimary } from "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId, t as listAgentEntries } from "./agent-scope-config-CMp71_27.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import "./config-B6Oplu5W.js";
import { i as resolveOpenClawReferencePaths, n as OPENCLAW_SOURCE_URL, t as OPENCLAW_DOCS_URL } from "./docs-path-DyXQ-M1b.js";
import { spawn } from "node:child_process";
//#region src/crestodian/probes.ts
async function probeLocalCommand(command, args = ["--version"], opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 1500;
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish({
				command,
				found: true,
				error: `timed out after ${timeoutMs}ms`
			});
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (err) => {
			finish({
				command,
				found: err.code !== "ENOENT",
				error: err.code === "ENOENT" ? "not found" : err.message
			});
		});
		child.on("close", (code) => {
			const text = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0]?.trim();
			finish({
				command,
				found: code === 0 || Boolean(text),
				version: text || void 0,
				error: code === 0 ? void 0 : `exited ${String(code)}`
			});
		});
	});
}
async function probeGatewayUrl(url, opts = {}) {
	const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
	const healthUrl = new URL("/healthz", httpUrl).toString();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 900);
	try {
		const response = await fetch(healthUrl, {
			method: "GET",
			signal: controller.signal
		});
		return {
			reachable: response.ok,
			url,
			error: response.ok ? void 0 : response.statusText
		};
	} catch (err) {
		return {
			reachable: false,
			url,
			error: err instanceof Error ? err.message : String(err)
		};
	} finally {
		clearTimeout(timeout);
	}
}
//#endregion
//#region src/crestodian/overview.ts
function issueMessages(snapshot) {
	return snapshot.issues.map((issue) => {
		return `${issue.path ? `${issue.path}: ` : ""}${issue.message}`;
	});
}
function buildAgentSummaries(cfg) {
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const entries = listAgentEntries(cfg);
	if (entries.length === 0) return [{
		id: defaultAgentId,
		isDefault: true,
		model: resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)
	}];
	const seen = /* @__PURE__ */ new Set();
	const summaries = [];
	for (const entry of entries) {
		const id = normalizeAgentId(entry.id);
		if (seen.has(id)) continue;
		seen.add(id);
		const summary = {
			id,
			isDefault: id === defaultAgentId
		};
		if (typeof entry.name === "string") summary.name = entry.name;
		const model = resolveAgentEffectiveModelPrimary(cfg, id);
		if (model) summary.model = model;
		if (typeof entry.workspace === "string") summary.workspace = entry.workspace;
		summaries.push(summary);
	}
	return summaries;
}
function resolveFastTestReferences(env) {
	if (env.OPENCLAW_TEST_FAST !== "1") return;
	const sourcePath = process.cwd();
	return {
		sourcePath,
		docsPath: `${sourcePath}/docs`
	};
}
async function loadCrestodianOverview(opts = {}) {
	const env = opts.env ?? process.env;
	const deps = opts.deps ?? {};
	const snapshot = await (deps.readConfigFileSnapshot ?? readConfigFileSnapshot)();
	const cfg = snapshot.runtimeConfig ?? snapshot.sourceConfig ?? {};
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const defaultModel = resolveAgentEffectiveModelPrimary(cfg, defaultAgentId) ?? resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
	const configPath = snapshot.path || (deps.resolveConfigPath ?? resolveConfigPath)(env);
	let gatewayUrl = `ws://127.0.0.1:${(deps.resolveGatewayPort ?? resolveGatewayPort)(cfg, env)}`;
	let gatewaySource = "local loopback";
	let gatewayError;
	try {
		const details = (deps.buildGatewayConnectionDetails ?? (await import("./call-C8FPOqHS.js")).buildGatewayConnectionDetails)({
			config: cfg,
			configPath
		});
		gatewayUrl = details.url;
		gatewaySource = details.urlSource;
		gatewayError = details.remoteFallbackNote;
	} catch (err) {
		gatewayError = err instanceof Error ? err.message : String(err);
	}
	const resolveReferences = deps.resolveOpenClawReferencePaths ?? resolveOpenClawReferencePaths;
	const commandProbe = deps.probeLocalCommand ?? probeLocalCommand;
	const [codex, claude, gateway, references] = await Promise.all([
		commandProbe("codex"),
		commandProbe("claude"),
		(deps.probeGatewayUrl ?? probeGatewayUrl)(gatewayUrl),
		resolveFastTestReferences(env) ?? resolveReferences({
			argv1: process.argv[1],
			cwd: process.cwd(),
			moduleUrl: import.meta.url
		})
	]);
	return {
		config: {
			path: configPath,
			exists: snapshot.exists,
			valid: snapshot.valid,
			issues: issueMessages(snapshot),
			hash: snapshot.hash ?? null
		},
		agents: buildAgentSummaries(cfg),
		defaultAgentId,
		defaultModel,
		tools: {
			codex,
			claude,
			apiKeys: {
				openai: Boolean(env.OPENAI_API_KEY?.trim()),
				anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim())
			}
		},
		gateway: {
			url: gateway.url,
			source: gatewaySource,
			reachable: gateway.reachable,
			error: gateway.error ?? gatewayError
		},
		references: {
			docsPath: references.docsPath ?? void 0,
			docsUrl: OPENCLAW_DOCS_URL,
			sourcePath: references.sourcePath ?? void 0,
			sourceUrl: OPENCLAW_SOURCE_URL
		}
	};
}
function formatCommandProbe(probe) {
	if (!probe.found) return "not found";
	if (probe.version) return probe.version;
	return probe.error ? `found (${probe.error})` : "found";
}
function formatCrestodianOverview(overview) {
	const agentLines = overview.agents.map((agent) => {
		return `  - ${[
			agent.id,
			agent.isDefault ? "default" : void 0,
			agent.name ? `name=${agent.name}` : void 0,
			agent.model ? `model=${agent.model}` : void 0,
			agent.workspace ? `workspace=${agent.workspace}` : void 0
		].filter(Boolean).join(" | ")}`;
	});
	const configStatus = overview.config.valid ? overview.config.exists ? "valid" : "missing (configless rescue mode)" : "invalid";
	const issueLines = overview.config.issues.length > 0 ? ["Config issues:", ...overview.config.issues.map((issue) => `  - ${issue}`)] : [];
	return [
		"Crestodian online. Little claws, typed tools.",
		"",
		`Config: ${configStatus}`,
		`Path: ${overview.config.path}`,
		`Default agent: ${overview.defaultAgentId}`,
		`Default model: ${overview.defaultModel ?? "not configured"}`,
		"Agents:",
		...agentLines,
		`Codex: ${formatCommandProbe(overview.tools.codex)}`,
		`Claude Code: ${formatCommandProbe(overview.tools.claude)}`,
		`API keys: OpenAI ${overview.tools.apiKeys.openai ? "found" : "not found"}, Anthropic ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
		`Planner: ${overview.defaultModel ? `model-assisted via ${overview.defaultModel} for fuzzy local commands` : "deterministic only until a model is configured"}`,
		`Docs: ${overview.references.docsPath ?? overview.references.docsUrl}`,
		overview.references.sourcePath ? `Source: ${overview.references.sourcePath}` : `Source: ${overview.references.sourceUrl}`,
		`Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"} (${overview.gateway.url}, ${overview.gateway.source})`,
		overview.gateway.error ? `Gateway note: ${overview.gateway.error}` : void 0,
		`Next: ${recommendCrestodianNextStep(overview)}`,
		...issueLines
	].filter((line) => line !== void 0).join("\n");
}
function recommendCrestodianNextStep(overview) {
	if (!overview.config.exists) return "run \"setup\" to create a starter config";
	if (!overview.config.valid) return "run \"validate config\" or \"doctor\" to inspect the config";
	if (!overview.defaultModel) return "run \"setup\" or \"set default model <provider/model>\"";
	if (!overview.gateway.reachable) return "run \"gateway status\" or \"restart gateway\"";
	return "run \"talk to agent\" to enter your default agent";
}
function formatStartupConfigStatus(overview) {
	if (!overview.config.exists) return "missing";
	return overview.config.valid ? "valid" : "invalid";
}
function formatStartupUse(overview) {
	if (overview.defaultModel) return `Using: ${overview.defaultModel} for fuzzy local planning.`;
	return "Using: deterministic typed commands until we configure a model.";
}
function formatStartupGatewayStatus(overview) {
	if (overview.gateway.reachable) return `Gateway: reachable at ${overview.gateway.url}.`;
	return `Gateway: not reachable at ${overview.gateway.url}; I already did the first probe.`;
}
function formatStartupAction(overview) {
	if (!overview.config.exists) return "I can start by creating a starter config with `setup`.";
	if (!overview.config.valid) return "I can start debugging with `validate config` or `doctor`.";
	if (!overview.defaultModel) return "I can start by choosing a model with `setup`.";
	if (!overview.gateway.reachable) return "I can start debugging with `gateway status`, or queue `restart gateway` for approval.";
	return "Everything basic is reachable. Use `talk to agent` when you want the normal agent.";
}
function formatCrestodianStartupMessage(overview) {
	const agent = overview.agents.find((entry) => entry.id === overview.defaultAgentId);
	const agentLabel = agent?.name ? `${overview.defaultAgentId} (${agent.name})` : overview.defaultAgentId;
	return [
		"## Hi, I'm Crestodian.",
		"",
		"- Start me when setup, config, Gateway, model choice, or agent routing feels off.",
		`- ${formatStartupUse(overview)}`,
		`- Config: ${formatStartupConfigStatus(overview)}. Default agent: ${agentLabel}.`,
		`- ${formatStartupGatewayStatus(overview)}`,
		"",
		formatStartupAction(overview)
	].join("\n");
}
//#endregion
export { formatCrestodianStartupMessage as n, loadCrestodianOverview as r, formatCrestodianOverview as t };
