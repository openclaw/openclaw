import { c as normalizeOptionalString, p as resolvePrimaryStringValue, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { T as resolveExecutablePath } from "./exec-safe-bin-trust-DTg2jg2F.js";
import { i as resolveAuthStorePathForDisplay } from "./path-resolve-C6Vj5eOM.js";
import { n as CLAUDE_CLI_PROFILE_ID } from "./constants-D_82oc2f.js";
import { F as readClaudeCliCredentialsCached, n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import "./paths-DuwII6c5.js";
import { t as resolveModelAgentRuntimeMetadata } from "./agent-runtime-metadata-DOglN8Yf.js";
import { t as note } from "./note-Dg2Luaaq.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/commands/doctor-claude-cli.ts
const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_DIRNAME = path.join(".claude", "projects");
const MAX_SANITIZED_PROJECT_LENGTH = 200;
function usesClaudeCliModelSelection(cfg) {
	if (normalizeOptionalLowercaseString(resolvePrimaryStringValue(cfg.agents?.defaults?.model))?.startsWith(`${CLAUDE_CLI_PROVIDER}/`)) return true;
	return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) => normalizeOptionalLowercaseString(key)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`));
}
function resolveClaudeCliCommand(cfg) {
	const configured = cfg.agents?.defaults?.cliBackends ?? {};
	for (const [key, entry] of Object.entries(configured)) {
		if (normalizeOptionalLowercaseString(key) !== CLAUDE_CLI_PROVIDER) continue;
		const command = normalizeOptionalString(entry?.command);
		if (command) return command;
	}
	return "claude";
}
function simpleHash36(input) {
	let hash = 0;
	for (let index = 0; index < input.length; index += 1) hash = hash * 31 + input.charCodeAt(index) >>> 0;
	return hash.toString(36);
}
function sanitizeClaudeCliProjectKey(workspaceDir) {
	const sanitized = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_SANITIZED_PROJECT_LENGTH) return sanitized;
	return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_LENGTH)}-${simpleHash36(workspaceDir)}`;
}
function canonicalizeWorkspaceDir(workspaceDir) {
	const resolved = path.resolve(workspaceDir).normalize("NFC");
	try {
		return fs.realpathSync.native(resolved).normalize("NFC");
	} catch {
		return resolved;
	}
}
function resolveClaudeCliProjectDirForWorkspace(params) {
	const homeDir = normalizeOptionalString(params.homeDir) || process.env.HOME || os.homedir();
	const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
	return path.join(homeDir, CLAUDE_PROJECTS_DIRNAME, sanitizeClaudeCliProjectKey(canonicalWorkspaceDir));
}
function probeDirectoryHealth(dirPath) {
	try {
		if (!fs.statSync(dirPath).isDirectory()) return "not_directory";
	} catch {
		return "missing";
	}
	try {
		fs.accessSync(dirPath, fs.constants.R_OK);
	} catch {
		return "unreadable";
	}
	try {
		fs.accessSync(dirPath, fs.constants.W_OK);
	} catch {
		return "readonly";
	}
	return "present";
}
function formatCredentialLabel(credential) {
	if (credential.type === "oauth" || credential.type === "token") return credential.type;
	return "unknown";
}
function formatWorkspaceHealthLine(workspaceDir, health, agentId) {
	const label = agentId ? `Agent ${agentId} workspace` : "Workspace";
	const display = shortenHomePath(workspaceDir);
	if (health === "present") return `- ${label}: ${display} (writable).`;
	if (health === "missing") return `- ${label}: ${display} (missing; OpenClaw will create it on first run).`;
	if (health === "not_directory") return `- ${label}: ${display} exists but is not a directory.`;
	if (health === "unreadable") return `- ${label}: ${display} is not readable by this user.`;
	return `- ${label}: ${display} is not writable by this user.`;
}
function formatProjectDirHealthLine(projectDir, health, agentId) {
	const label = agentId ? `Agent ${agentId} Claude project dir` : "Claude project dir";
	const display = shortenHomePath(projectDir);
	if (health === "present") return `- ${label}: ${display} (present).`;
	if (health === "missing") return `- ${label}: ${display} (not created yet; it appears after the first Claude CLI turn in this workspace).`;
	if (health === "not_directory") return `- ${label}: ${display} exists but is not a directory.`;
	if (health === "unreadable") return `- ${label}: ${display} is not readable by this user.`;
	return `- ${label}: ${display} is not writable by this user.`;
}
function resolveClaudeCliAgentIds(cfg) {
	const runtimeAgentIds = listAgentIds(cfg).filter((agentId) => resolveModelAgentRuntimeMetadata({
		cfg,
		agentId
	}).id === CLAUDE_CLI_PROVIDER);
	if (runtimeAgentIds.length > 0) return runtimeAgentIds;
	if (usesClaudeCliModelSelection(cfg)) return [resolveDefaultAgentId(cfg)];
	return [];
}
function resolveClaudeCliWorkspaceTargets(params) {
	const agentIds = resolveClaudeCliAgentIds(params.cfg);
	const defaultAgentId = resolveDefaultAgentId(params.cfg);
	const seen = /* @__PURE__ */ new Set();
	return agentIds.filter((agentId) => {
		if (seen.has(agentId)) return false;
		seen.add(agentId);
		return true;
	}).map((agentId) => {
		const workspaceDir = params.workspaceDir && agentIds.length === 1 && agentId === defaultAgentId ? params.workspaceDir : resolveAgentWorkspaceDir(params.cfg, agentId, params.env);
		const projectDir = resolveClaudeCliProjectDirForWorkspace({
			workspaceDir,
			homeDir: params.homeDir
		});
		return {
			agentId,
			workspaceDir,
			projectDir,
			workspaceHealth: probeDirectoryHealth(workspaceDir),
			projectDirHealth: probeDirectoryHealth(projectDir)
		};
	});
}
function noteClaudeCliHealth(cfg, deps) {
	const env = deps?.env ?? process.env;
	const workspaceTargets = resolveClaudeCliWorkspaceTargets({
		cfg,
		env,
		homeDir: deps?.homeDir,
		workspaceDir: deps?.workspaceDir
	});
	if (workspaceTargets.length === 0) return;
	const store = deps?.store ?? ensureAuthProfileStore(void 0, { allowKeychainPrompt: false });
	const credential = (deps?.readClaudeCliCredentials ?? (() => readClaudeCliCredentialsCached({ allowKeychainPrompt: false })))();
	const command = resolveClaudeCliCommand(cfg);
	const commandPath = (deps?.resolveCommandPath ?? ((rawCommand, nextEnv) => resolveExecutablePath(rawCommand, { env: nextEnv })))(command, env);
	const authStorePath = resolveAuthStorePathForDisplay();
	const storedProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const showAgentLabels = workspaceTargets.length > 1 || workspaceTargets.some((target) => target.agentId !== defaultAgentId);
	const lines = [];
	const fixHints = [];
	if (commandPath) lines.push(`- Binary: ${shortenHomePath(commandPath)}.`);
	else {
		lines.push(`- Binary: command "${command}" was not found on PATH.`);
		fixHints.push("- Fix: install Claude CLI or set agents.defaults.cliBackends.claude-cli.command to the real binary path.");
	}
	if (credential) lines.push(`- Headless Claude auth: OK (${formatCredentialLabel(credential)}).`);
	else {
		lines.push("- Headless Claude auth: unavailable without interactive prompting.");
		fixHints.push(`- Fix: run ${formatCliCommand("claude auth login")}, then ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`);
	}
	if (!storedProfile) {
		lines.push(`- OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID}) in ${authStorePath}.`);
		fixHints.push(`- Fix: run ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`);
	} else if (storedProfile.provider !== CLAUDE_CLI_PROVIDER) {
		lines.push(`- OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} is wired to provider "${storedProfile.provider}" instead of "${CLAUDE_CLI_PROVIDER}".`);
		fixHints.push(`- Fix: rerun ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")} to rewrite the profile cleanly.`);
	} else lines.push(`- OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} (provider ${CLAUDE_CLI_PROVIDER}).`);
	for (const target of workspaceTargets) {
		const agentLabel = showAgentLabels ? target.agentId : void 0;
		lines.push(formatWorkspaceHealthLine(target.workspaceDir, target.workspaceHealth, agentLabel));
		if (target.workspaceHealth === "readonly" || target.workspaceHealth === "unreadable" || target.workspaceHealth === "not_directory") fixHints.push(`- Fix: make ${agentLabel ? `agent ${agentLabel}'s workspace` : "the workspace"} a readable, writable directory for the gateway user.`);
		lines.push(formatProjectDirHealthLine(target.projectDir, target.projectDirHealth, agentLabel));
		if (target.projectDirHealth === "unreadable" || target.projectDirHealth === "not_directory") fixHints.push(`- Fix: make ${agentLabel ? `agent ${agentLabel}'s Claude project dir` : "the Claude project dir"} readable, or remove the broken path and let Claude recreate it.`);
	}
	if (workspaceTargets.length > 1) lines.push(`- Agents using Claude CLI: ${workspaceTargets.map((target) => target.agentId).join(", ")}.`);
	if (fixHints.length > 0) lines.push(...fixHints);
	(deps?.noteFn ?? note)(lines.join("\n"), "Claude CLI");
}
//#endregion
export { noteClaudeCliHealth };
