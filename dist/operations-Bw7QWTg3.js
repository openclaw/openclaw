import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { g as shortenHomePath, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { l as normalizeAgentId, r as buildAgentMainSessionKey } from "./session-key-Bte0mmcq.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/crestodian/audit.ts
function resolveCrestodianAuditPath(env = process.env, stateDir = resolveStateDir(env)) {
	return path.join(stateDir, "audit", "crestodian.jsonl");
}
async function appendCrestodianAuditEntry(entry, opts = {}) {
	const auditPath = opts.auditPath ?? resolveCrestodianAuditPath(opts.env);
	await fs.mkdir(path.dirname(auditPath), { recursive: true });
	await appendRegularFile({
		filePath: auditPath,
		content: `${JSON.stringify({
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			...entry
		})}\n`,
		rejectSymlinkParents: true
	});
	return auditPath;
}
//#endregion
//#region src/crestodian/operations.ts
const SET_MODEL_RE = /(?:set|configure|use)\s+(?:the\s+)?(?:default\s+)?model\s+(.+)/i;
const CONFIGURE_MODELS_RE = /(?:set|configure|use)\s+models?\s+(?<model>\S+)/i;
const CREATE_AGENT_RE = /(?:create|add|setup|set\s+up)\s+(?:(?:an?|new|my)\s+)?agent\s+(?<agent>[a-z0-9_-]+)/i;
const TALK_AGENT_RE = /(?:talk\s+to|switch\s+to|open|enter)\s+(?:(?:my|the)\s+)?(?:(?<agent>[a-z0-9_-]+)\s+)?agent/i;
const WORKSPACE_RE = /(?:workspace|workdir|cwd|for|in)\s+(?<workspace>"[^"]+"|'[^']+'|\S+)/i;
const MODEL_RE = /\bmodel\s+(?<model>\S+)/i;
const CONFIG_SET_RE = /^(?:config\s+set|set\s+config)\s+(?<path>[A-Za-z0-9_.[\]-]+)\s+(?<value>.+)$/i;
const CONFIG_SET_REF_RE = /^(?:config\s+set-ref|set\s+secretref|set\s+secret\s+ref)\s+(?<path>[A-Za-z0-9_.[\]-]+)\s+(?:(?<source>env|file|exec)\s+)?(?<id>\S+)(?:\s+provider\s+(?<provider>[A-Za-z0-9_-]+))?$/i;
const SETUP_RE = /^(?:setup(?!\s+agent\b)|set\s+me\s+up|set\s+up\s+openclaw|onboard|onboard\s+me|bootstrap|first\s+run)(?:\b|$)/i;
const PLUGIN_LIST_RE = /^(?:plugins?|clawhub)\s+list$|^list\s+plugins?$/i;
const PLUGIN_SEARCH_RE = /^(?:(?:plugins?|clawhub)\s+search|search\s+plugins?(?:\s+for)?)\s+(?<query>.+)$/i;
const PLUGIN_INSTALL_RE = /^(?:(?:plugins?)\s+install|install\s+(?:(?<source>npm|clawhub)\s+)?plugins?)\s+(?<spec>\S+)$/i;
const PLUGIN_UNINSTALL_RE = /^(?:(?:plugins?)\s+(?:uninstall|remove)|(?:uninstall|remove)\s+plugins?)\s+(?<pluginId>[A-Za-z0-9_.@/-]+)$/i;
const OPENAI_API_DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
const ANTHROPIC_API_DEFAULT_MODEL_REF = "anthropic/claude-opus-4-7";
const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-4-7";
const CODEX_APP_SERVER_DEFAULT_MODEL_REF = "openai/gpt-5.5";
function parseCrestodianOperation(input) {
	const trimmed = input.trim();
	const lower = trimmed.toLowerCase();
	if (!trimmed) return {
		kind: "none",
		message: "Tiny claw tap: say status, doctor, models, agents, or talk to agent."
	};
	if ([
		"help",
		"?",
		"overview",
		"system"
	].includes(lower)) return { kind: "overview" };
	if (lower === "audit" || lower.includes("audit log")) return { kind: "audit" };
	const configSetRefMatch = trimmed.match(CONFIG_SET_REF_RE);
	if (configSetRefMatch?.groups?.path && configSetRefMatch.groups.id?.trim()) {
		const source = configSetRefMatch.groups.source?.toLowerCase() ?? "env";
		return {
			kind: "config-set-ref",
			path: configSetRefMatch.groups.path,
			source,
			id: configSetRefMatch.groups.id.trim(),
			...configSetRefMatch.groups.provider ? { provider: configSetRefMatch.groups.provider } : {}
		};
	}
	const configSetMatch = trimmed.match(CONFIG_SET_RE);
	if (configSetMatch?.groups?.path && configSetMatch.groups.value?.trim()) return {
		kind: "config-set",
		path: configSetMatch.groups.path,
		value: configSetMatch.groups.value.trim()
	};
	if (lower === "config validate" || lower === "validate config" || lower.includes("validate config")) return { kind: "config-validate" };
	if (PLUGIN_LIST_RE.test(trimmed)) return { kind: "plugin-list" };
	const pluginSearchMatch = trimmed.match(PLUGIN_SEARCH_RE);
	if (pluginSearchMatch?.groups?.query?.trim()) return {
		kind: "plugin-search",
		query: pluginSearchMatch.groups.query.trim()
	};
	const pluginInstallMatch = trimmed.match(PLUGIN_INSTALL_RE);
	if (pluginInstallMatch?.groups?.spec?.trim()) return {
		kind: "plugin-install",
		spec: normalizePluginInstallSpec(pluginInstallMatch.groups.spec.trim(), pluginInstallMatch.groups.source)
	};
	const pluginUninstallMatch = trimmed.match(PLUGIN_UNINSTALL_RE);
	if (pluginUninstallMatch?.groups?.pluginId?.trim()) return {
		kind: "plugin-uninstall",
		pluginId: pluginUninstallMatch.groups.pluginId.trim()
	};
	if (SETUP_RE.test(lower)) {
		const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
		const model = trimmed.match(MODEL_RE)?.groups?.model;
		return {
			kind: "setup",
			...workspace ? { workspace } : {},
			...model ? { model } : {}
		};
	}
	if (lower.includes("doctor")) {
		if (lower.includes("fix") || lower.includes("repair")) return { kind: "doctor-fix" };
		return { kind: "doctor" };
	}
	if (lower.includes("health")) return { kind: "health" };
	if (lower.includes("gateway")) {
		if (lower.includes("restart")) return { kind: "gateway-restart" };
		if (lower.includes("start")) return { kind: "gateway-start" };
		if (lower.includes("stop")) return { kind: "gateway-stop" };
		return { kind: "gateway-status" };
	}
	if (lower.includes("status")) return { kind: "status" };
	if (lower.includes("agent")) {
		const createMatch = trimmed.match(CREATE_AGENT_RE);
		if (createMatch?.groups?.agent) {
			const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
			const model = trimmed.match(MODEL_RE)?.groups?.model;
			return {
				kind: "create-agent",
				agentId: normalizeAgentId(createMatch.groups.agent),
				...workspace ? { workspace } : {},
				...model ? { model } : {}
			};
		}
		const talkMatch = trimmed.match(TALK_AGENT_RE);
		if (talkMatch) {
			const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
			return {
				kind: "open-tui",
				agentId: talkMatch.groups?.agent,
				...workspace ? { workspace } : {}
			};
		}
		return { kind: "agents" };
	}
	if (lower.includes("model")) {
		const match = trimmed.match(SET_MODEL_RE);
		const pluralMatch = trimmed.match(CONFIGURE_MODELS_RE);
		const model = match?.[1]?.trim() ?? pluralMatch?.groups?.model?.trim();
		if (model) return {
			kind: "set-default-model",
			model
		};
		return { kind: "models" };
	}
	if (lower === "tui" || lower.includes("open tui") || lower.includes("chat")) return { kind: "open-tui" };
	if (lower === "quit" || lower === "exit") return {
		kind: "none",
		message: "Crestodian retracts into shell. Bye."
	};
	return {
		kind: "none",
		message: "I can run doctor/status/health, check or restart Gateway, list agents/models, set default model, show audit, or switch to your agent TUI."
	};
}
function trimShellishToken(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).trim() || void 0;
	return trimmed;
}
function normalizePluginInstallSpec(spec, source) {
	const trimmed = spec.trim();
	const normalizedSource = source?.toLowerCase();
	if (normalizedSource === "npm" && !trimmed.toLowerCase().startsWith("npm:")) return `npm:${trimmed}`;
	if (normalizedSource === "clawhub" && !trimmed.toLowerCase().startsWith("clawhub:")) return `clawhub:${trimmed}`;
	return trimmed;
}
function validateCrestodianPluginInstallSpec(spec) {
	const trimmed = spec.trim();
	if (!trimmed) return "Plugin install spec is required.";
	if (/\s/.test(trimmed)) return "Crestodian plugin install accepts one npm or ClawHub package spec.";
	if (/^(?:\.{1,2}\/|\/|~\/|file:|git(?:\+ssh|\+https)?:|https?:)/i.test(trimmed)) return "Crestodian plugin install accepts npm or ClawHub package specs only.";
	return null;
}
function isPersistentCrestodianOperation(operation) {
	return operation.kind === "set-default-model" || operation.kind === "config-set" || operation.kind === "config-set-ref" || operation.kind === "setup" || operation.kind === "doctor-fix" || operation.kind === "plugin-install" || operation.kind === "plugin-uninstall" || operation.kind === "create-agent" || operation.kind === "gateway-start" || operation.kind === "gateway-stop" || operation.kind === "gateway-restart";
}
function describeCrestodianPersistentOperation(operation) {
	switch (operation.kind) {
		case "set-default-model": return `set agents.defaults.model.primary to ${operation.model}`;
		case "config-set": return `set config ${operation.path} to ${formatConfigSetValueForPlan(operation.path, operation.value)}`;
		case "config-set-ref": return `set config ${operation.path} to ${operation.source} SecretRef ${operation.source === "env" ? operation.id : "<redacted>"}`;
		case "setup": return formatSetupPlanDescription(operation);
		case "doctor-fix": return "run doctor repairs";
		case "plugin-install": return `install plugin ${operation.spec}`;
		case "plugin-uninstall": return `uninstall plugin ${operation.pluginId}`;
		case "create-agent": return `create agent ${operation.agentId} with workspace ${formatCreateAgentWorkspace(operation.workspace)}`;
		case "gateway-start": return "start the Gateway";
		case "gateway-stop": return "stop the Gateway";
		case "gateway-restart": return "restart the Gateway";
		default: return "apply this action";
	}
}
function formatCrestodianPersistentPlan(operation) {
	return `Plan: ${describeCrestodianPersistentOperation(operation)}. Say yes to apply.`;
}
function formatCreateAgentWorkspace(workspace) {
	return workspace ? shortenHomePath(resolveUserPath(workspace)) : shortenHomePath(process.cwd());
}
function formatConfigSetValueForPlan(configPath, value) {
	if (/(secret|token|password|key|credential)/i.test(configPath)) return "<redacted>";
	return value;
}
function formatSetupPlanDescription(operation) {
	return `bootstrap OpenClaw setup for workspace ${shortenHomePath(resolveUserPath(operation.workspace ?? process.cwd()))}${operation.model ? ` and default model ${operation.model}` : ""}`;
}
function chooseSetupModel(overview, requestedModel) {
	if (requestedModel?.trim()) return {
		model: requestedModel.trim(),
		source: "requested"
	};
	if (overview.defaultModel) return { source: "existing default model" };
	if (overview.tools.apiKeys.openai) return {
		model: OPENAI_API_DEFAULT_MODEL_REF,
		source: "OPENAI_API_KEY"
	};
	if (overview.tools.apiKeys.anthropic) return {
		model: ANTHROPIC_API_DEFAULT_MODEL_REF,
		source: "ANTHROPIC_API_KEY"
	};
	if (overview.tools.claude.found) return {
		model: CLAUDE_CLI_DEFAULT_MODEL_REF,
		source: "Claude Code CLI"
	};
	if (overview.tools.codex.found) return {
		model: CODEX_APP_SERVER_DEFAULT_MODEL_REF,
		source: "Codex app-server"
	};
	return { source: "none" };
}
function logQueued(runtime, operation) {
	runtime.log(`[crestodian] queued: ${operation}`);
	runtime.log(`[crestodian] running: ${operation}`);
}
function formatGatewayStatusLine(overview) {
	return [
		`Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"}`,
		`URL: ${overview.gateway.url}`,
		`Source: ${overview.gateway.source}`,
		overview.gateway.error ? `Note: ${overview.gateway.error}` : void 0
	].filter((line) => line !== void 0).join("\n");
}
async function runGatewayLifecycle(operation) {
	const lifecycle = await import("./lifecycle-Bmv2VAbn.js");
	if (operation === "start") {
		await lifecycle.runDaemonStart();
		return;
	}
	if (operation === "stop") {
		await lifecycle.runDaemonStop();
		return;
	}
	await lifecycle.runDaemonRestart();
}
async function readConfigFileSnapshotLazy() {
	const { readConfigFileSnapshot } = await import("./config/config.js");
	return await readConfigFileSnapshot();
}
async function loadOverviewForOperation(deps) {
	if (deps?.loadOverview) return await deps.loadOverview();
	const { loadCrestodianOverview } = await import("./overview-Byb9qGXS.js");
	return await loadCrestodianOverview();
}
async function formatOverviewForOperation(overview, deps) {
	if (deps?.formatOverview) return deps.formatOverview(overview);
	const { formatCrestodianOverview } = await import("./overview-Byb9qGXS.js");
	return formatCrestodianOverview(overview);
}
async function loadConfigFileMutationHelpers() {
	const { mutateConfigFile, readConfigFileSnapshot } = await import("./config/config.js");
	return {
		mutateConfigFile,
		readConfigFileSnapshot
	};
}
function formatConfigValidationLine(snapshot) {
	if (!snapshot.exists) return `Config missing: ${shortenHomePath(snapshot.path)}`;
	if (snapshot.valid) return `Config valid: ${shortenHomePath(snapshot.path)}`;
	return [`Config invalid: ${shortenHomePath(snapshot.path)}`, ...snapshot.issues.map((issue) => {
		return `  - ${issue.path ? `${issue.path}: ` : ""}${issue.message}`;
	})].join("\n");
}
function createNoExitRuntime(runtime) {
	return {
		...runtime,
		exit: (code) => {
			throw new Error(`operation exited with code ${code}`);
		}
	};
}
async function resolveTuiAgentId(params) {
	const overview = await loadOverviewForOperation(params.deps);
	const workspace = params.requestedWorkspace ? resolveUserPath(params.requestedWorkspace) : void 0;
	if (workspace) {
		const workspaceMatch = overview.agents.find((agent) => {
			return agent.workspace ? resolveUserPath(agent.workspace) === workspace : false;
		});
		if (workspaceMatch) return workspaceMatch.id;
	}
	if (!params.requestedAgentId?.trim()) return overview.defaultAgentId;
	const requested = normalizeAgentId(params.requestedAgentId);
	return overview.agents.find((agent) => {
		return normalizeAgentId(agent.id) === requested || (agent.name ? normalizeAgentId(agent.name) === requested : false);
	})?.id ?? requested;
}
async function executeCrestodianOperation(operation, runtime, opts = {}) {
	if (operation.kind === "none") {
		runtime.log(operation.message);
		return {
			applied: false,
			exitsInteractive: operation.message.includes("Bye.")
		};
	}
	if (operation.kind === "overview") {
		const overview = await loadOverviewForOperation(opts.deps);
		runtime.log(await formatOverviewForOperation(overview, opts.deps));
		return { applied: false };
	}
	if (operation.kind === "agents") {
		const overview = await loadOverviewForOperation(opts.deps);
		runtime.log(["Agents:", ...overview.agents.map((agent) => {
			return `  - ${[
				agent.id,
				agent.isDefault ? "default" : void 0,
				agent.name ? `name=${agent.name}` : void 0,
				agent.workspace ? `workspace=${shortenHomePath(resolveUserPath(agent.workspace))}` : void 0
			].filter(Boolean).join(" | ")}`;
		})].join("\n"));
		return { applied: false };
	}
	if (operation.kind === "models") {
		const overview = await loadOverviewForOperation(opts.deps);
		runtime.log([
			`Default model: ${overview.defaultModel ?? "not configured"}`,
			`Codex: ${overview.tools.codex.found ? "found" : "not found"}`,
			`Claude Code: ${overview.tools.claude.found ? "found" : "not found"}`,
			`OpenAI key: ${overview.tools.apiKeys.openai ? "found" : "not found"}`,
			`Anthropic key: ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`
		].join("\n"));
		return { applied: false };
	}
	if (operation.kind === "plugin-list") {
		logQueued(runtime, "plugins.list");
		await (opts.deps?.runPluginsList ?? (async (pluginRuntime) => {
			const { runPluginsListCommand } = await import("./plugins-list-command-DEJzW0rV.js");
			await runPluginsListCommand({}, pluginRuntime);
		}))(runtime);
		runtime.log("[crestodian] done: plugins.list");
		return { applied: false };
	}
	if (operation.kind === "plugin-search") {
		logQueued(runtime, "plugins.search");
		await (opts.deps?.runPluginsSearch ?? (async (query, pluginRuntime) => {
			const { runPluginsSearchCommand } = await import("./plugins-search-command-BBkbO_3X.js");
			await runPluginsSearchCommand(query, {}, pluginRuntime);
		}))(operation.query, runtime);
		runtime.log("[crestodian] done: plugins.search");
		return { applied: false };
	}
	if (operation.kind === "audit") {
		runtime.log(`Audit log: ${resolveCrestodianAuditPath()}`);
		runtime.log("Only applied writes/actions are recorded; discovery stays quiet.");
		return { applied: false };
	}
	if (operation.kind === "config-validate") {
		const snapshot = await readConfigFileSnapshotLazy();
		runtime.log(formatConfigValidationLine(snapshot));
		return { applied: false };
	}
	if (operation.kind === "setup") {
		const overview = await loadOverviewForOperation(opts.deps);
		const setupModel = chooseSetupModel(overview, operation.model);
		if (!opts.approved) {
			const message = [formatCrestodianPersistentPlan(operation), setupModel.model ? `Model choice: ${setupModel.model} (${setupModel.source}).` : setupModel.source === "existing default model" ? `Model choice: keep existing default ${overview.defaultModel}.` : "Model choice: none found yet. I will only set the workspace; install/login Codex or Claude Code, or set OPENAI_API_KEY/ANTHROPIC_API_KEY, then run setup again."].join("\n");
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "crestodian.setup");
		const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigFileMutationHelpers();
		const before = await readConfigFileSnapshot();
		const workspace = resolveUserPath(operation.workspace ?? process.cwd());
		const applyDefaultModelPrimaryUpdate = setupModel.model ? (await import("./shared-BN1GT6EX.js")).applyDefaultModelPrimaryUpdate : void 0;
		const result = await mutateConfigFile({
			base: "source",
			mutate: (cfg) => {
				let next = cfg;
				if (setupModel.model && applyDefaultModelPrimaryUpdate) next = applyDefaultModelPrimaryUpdate({
					cfg: next,
					modelRaw: setupModel.model,
					field: "model"
				});
				next = {
					...next,
					agents: {
						...next.agents,
						defaults: {
							...next.agents?.defaults,
							workspace
						}
					}
				};
				Object.assign(cfg, next);
			}
		});
		const after = await readConfigFileSnapshot();
		await appendCrestodianAuditEntry({
			operation: "crestodian.setup",
			summary: setupModel.model ? `Bootstrapped setup with ${setupModel.model}` : "Bootstrapped setup workspace",
			configPath: result.path,
			configHashBefore: before.hash ?? result.previousHash,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				workspace,
				modelSource: setupModel.source,
				...setupModel.model ? { model: setupModel.model } : {}
			}
		});
		runtime.log(`Updated ${result.path}`);
		runtime.log(`Workspace: ${shortenHomePath(workspace)}`);
		if (setupModel.model) runtime.log(`Default model: ${setupModel.model} (${setupModel.source})`);
		else if (overview.defaultModel) runtime.log(`Default model: ${overview.defaultModel} (kept)`);
		else runtime.log("Default model: not configured yet");
		runtime.log("[crestodian] done: crestodian.setup");
		return { applied: true };
	}
	if (operation.kind === "config-set") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "config.set");
		const { readConfigFileSnapshot } = await import("./config/config.js");
		const before = await readConfigFileSnapshot();
		await (opts.deps?.runConfigSet ?? (async (setOpts) => {
			const { runConfigSet: importedRunConfigSet } = await import("./config-cli-6z89Zcrf.js");
			await importedRunConfigSet({
				...setOpts,
				runtime: createNoExitRuntime(runtime)
			});
		}))({
			path: operation.path,
			value: operation.value,
			cliOptions: {}
		});
		const after = await readConfigFileSnapshot();
		await appendCrestodianAuditEntry({
			operation: "config.set",
			summary: `Set config ${operation.path}`,
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				path: operation.path
			}
		});
		runtime.log("[crestodian] done: config.set");
		return { applied: true };
	}
	if (operation.kind === "config-set-ref") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "config.setRef");
		const { readConfigFileSnapshot } = await import("./config/config.js");
		const before = await readConfigFileSnapshot();
		await (opts.deps?.runConfigSet ?? (async (setOpts) => {
			const { runConfigSet: importedRunConfigSet } = await import("./config-cli-6z89Zcrf.js");
			await importedRunConfigSet({
				...setOpts,
				runtime: createNoExitRuntime(runtime)
			});
		}))({
			path: operation.path,
			cliOptions: {
				refProvider: operation.provider ?? "default",
				refSource: operation.source,
				refId: operation.id
			}
		});
		const after = await readConfigFileSnapshot();
		await appendCrestodianAuditEntry({
			operation: "config.setRef",
			summary: `Set config ${operation.path} SecretRef`,
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				path: operation.path,
				source: operation.source,
				provider: operation.provider ?? "default"
			}
		});
		runtime.log("[crestodian] done: config.setRef");
		return { applied: true };
	}
	if (operation.kind === "plugin-install") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		const validationError = validateCrestodianPluginInstallSpec(operation.spec);
		if (validationError) {
			runtime.error(validationError);
			runtime.exit(1);
			return { applied: false };
		}
		logQueued(runtime, "plugin.install");
		const before = await readConfigFileSnapshotLazy();
		await (opts.deps?.runPluginInstall ?? (async (spec, pluginRuntime) => {
			const { runPluginInstallCommand } = await import("./plugins-install-command-CAMt5vXW.js");
			await runPluginInstallCommand({
				raw: spec,
				opts: {},
				runtime: pluginRuntime
			});
		}))(operation.spec, createNoExitRuntime(runtime));
		const after = await readConfigFileSnapshotLazy();
		await appendCrestodianAuditEntry({
			operation: "plugin.install",
			summary: `Installed plugin ${operation.spec}`,
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				spec: operation.spec
			}
		});
		runtime.log("[crestodian] done: plugin.install");
		runtime.log("Restart the Gateway to apply installed plugin changes.");
		return { applied: true };
	}
	if (operation.kind === "plugin-uninstall") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "plugin.uninstall");
		const before = await readConfigFileSnapshotLazy();
		await (opts.deps?.runPluginUninstall ?? (async (pluginId, pluginRuntime) => {
			const { runPluginUninstallCommand } = await import("./plugins-uninstall-command-BrIchRzz.js");
			await runPluginUninstallCommand(pluginId, { force: true }, pluginRuntime);
		}))(operation.pluginId, createNoExitRuntime(runtime));
		const after = await readConfigFileSnapshotLazy();
		await appendCrestodianAuditEntry({
			operation: "plugin.uninstall",
			summary: `Uninstalled plugin ${operation.pluginId}`,
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				pluginId: operation.pluginId
			}
		});
		runtime.log("[crestodian] done: plugin.uninstall");
		runtime.log("Restart the Gateway to apply plugin changes.");
		return { applied: true };
	}
	if (operation.kind === "create-agent") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "agents.create");
		const { readConfigFileSnapshot } = await import("./config/config.js");
		const before = await readConfigFileSnapshot();
		const workspace = resolveUserPath(operation.workspace ?? process.cwd());
		await (opts.deps?.runAgentsAdd ?? (await import("./agents.commands.add-idxZa6ND.js")).agentsAddCommand)({
			name: operation.agentId,
			workspace,
			...operation.model ? { model: operation.model } : {},
			nonInteractive: true
		}, runtime, { hasFlags: true });
		const after = await readConfigFileSnapshot();
		await appendCrestodianAuditEntry({
			operation: "agents.create",
			summary: `Created agent ${operation.agentId}`,
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				agentId: operation.agentId,
				workspace,
				...operation.model ? { model: operation.model } : {}
			}
		});
		runtime.log("[crestodian] done: agents.create");
		return { applied: true };
	}
	if (operation.kind === "doctor") {
		logQueued(runtime, "doctor");
		await (opts.deps?.runDoctor ?? (await import("./doctor-cpFtp-iT.js")).doctorCommand)(runtime, { nonInteractive: true });
		runtime.log("[crestodian] done: doctor");
		return { applied: false };
	}
	if (operation.kind === "doctor-fix") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "doctor.fix");
		const { readConfigFileSnapshot } = await import("./config/config.js");
		const before = await readConfigFileSnapshot();
		await (opts.deps?.runDoctor ?? (await import("./doctor-cpFtp-iT.js")).doctorCommand)(runtime, {
			nonInteractive: true,
			repair: true,
			yes: true
		});
		const after = await readConfigFileSnapshot();
		await appendCrestodianAuditEntry({
			operation: "doctor.fix",
			summary: "Ran doctor repairs",
			configPath: after.path || before.path || void 0,
			configHashBefore: before.hash ?? null,
			configHashAfter: after.hash ?? null,
			details: opts.auditDetails
		});
		runtime.log("[crestodian] done: doctor.fix");
		return { applied: true };
	}
	if (operation.kind === "status") {
		logQueued(runtime, "status.check");
		const { statusCommand } = await import("./status.command-CSqBrNLU.js");
		await statusCommand({ timeoutMs: 1e4 }, runtime);
		runtime.log("[crestodian] done: status.check");
		return { applied: false };
	}
	if (operation.kind === "health") {
		logQueued(runtime, "health.check");
		const { healthCommand } = await import("./health-Ihdx28c0.js");
		await healthCommand({ timeoutMs: 1e4 }, runtime);
		runtime.log("[crestodian] done: health.check");
		return { applied: false };
	}
	if (operation.kind === "gateway-status") {
		const overview = await loadOverviewForOperation(opts.deps);
		runtime.log(formatGatewayStatusLine(overview));
		return { applied: false };
	}
	if (operation.kind === "gateway-start") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "gateway.start");
		await (opts.deps?.runGatewayStart ?? (() => runGatewayLifecycle("start")))();
		await appendCrestodianAuditEntry({
			operation: "gateway.start",
			summary: "Started Gateway",
			details: opts.auditDetails
		});
		runtime.log("[crestodian] done: gateway.start");
		return { applied: true };
	}
	if (operation.kind === "gateway-stop") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "gateway.stop");
		await (opts.deps?.runGatewayStop ?? (() => runGatewayLifecycle("stop")))();
		await appendCrestodianAuditEntry({
			operation: "gateway.stop",
			summary: "Stopped Gateway",
			details: opts.auditDetails
		});
		runtime.log("[crestodian] done: gateway.stop");
		return { applied: true };
	}
	if (operation.kind === "gateway-restart") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "gateway.restart");
		await (opts.deps?.runGatewayRestart ?? (() => runGatewayLifecycle("restart")))();
		await appendCrestodianAuditEntry({
			operation: "gateway.restart",
			summary: "Restarted Gateway",
			details: opts.auditDetails
		});
		runtime.log("[crestodian] done: gateway.restart");
		return { applied: true };
	}
	if (operation.kind === "open-tui") {
		logQueued(runtime, "tui.open");
		const agentId = await resolveTuiAgentId({
			requestedAgentId: operation.agentId,
			requestedWorkspace: operation.workspace,
			deps: opts.deps
		});
		const session = agentId ? buildAgentMainSessionKey({ agentId }) : void 0;
		const result = await (opts.deps?.runTui ?? (await import("./tui-BDW2N68q.js")).runTui)({
			local: true,
			session,
			deliver: false,
			historyLimit: 200
		});
		if (result?.exitReason === "return-to-crestodian") {
			runtime.log(result.crestodianMessage ? `[crestodian] returned from agent with request: ${result.crestodianMessage}` : "[crestodian] returned from agent");
			return {
				applied: false,
				nextInput: result.crestodianMessage
			};
		}
		return {
			applied: false,
			exitsInteractive: true
		};
	}
	if (operation.kind === "set-default-model") {
		if (!opts.approved) {
			const message = formatCrestodianPersistentPlan(operation);
			runtime.log(message);
			return {
				applied: false,
				message
			};
		}
		logQueued(runtime, "config.setDefaultModel");
		const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigFileMutationHelpers();
		const before = await readConfigFileSnapshot();
		const { applyDefaultModelPrimaryUpdate } = await import("./shared-BN1GT6EX.js");
		const result = await mutateConfigFile({
			base: "source",
			mutate: (cfg) => {
				const next = applyDefaultModelPrimaryUpdate({
					cfg,
					modelRaw: operation.model,
					field: "model"
				});
				Object.assign(cfg, next);
			}
		});
		const after = await readConfigFileSnapshot();
		const { resolveAgentModelPrimaryValue } = await import("./model-input-BOkgCg0o.js");
		const effectiveModel = resolveAgentModelPrimaryValue(result.nextConfig.agents?.defaults?.model);
		await appendCrestodianAuditEntry({
			operation: "config.setDefaultModel",
			summary: `Set default model to ${operation.model}`,
			configPath: result.path,
			configHashBefore: before.hash ?? result.previousHash,
			configHashAfter: after.hash ?? null,
			details: {
				...opts.auditDetails,
				requestedModel: operation.model,
				effectiveModel
			}
		});
		runtime.log(`Updated ${result.path}`);
		runtime.log(`Default model: ${effectiveModel ?? operation.model}`);
		runtime.log("[crestodian] done: config.setDefaultModel");
		return { applied: true };
	}
	return { applied: false };
}
//#endregion
export { parseCrestodianOperation as a, isPersistentCrestodianOperation as i, executeCrestodianOperation as n, formatCrestodianPersistentPlan as r, describeCrestodianPersistentOperation as t };
