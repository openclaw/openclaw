import { t as formatDocsLink } from "./links-BszRQhGa.js";
import { r as theme } from "./theme-B128avno.js";
import { t as createLazyImportLoader } from "./lazy-promise-BWWZqHu4.js";
import { t as hasExplicitOptions } from "./command-options-C2ZTJm5U.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { n as safeParseWithSchema } from "./zod-parse-CnyYByY3.js";
import { n as runCommandWithRuntime } from "./cli-utils-Bfcw6rvE.js";
import { t as setupWizardCommand } from "./onboard-gA7hm8hf.js";
import JSON5 from "json5";
import fs from "node:fs/promises";
import { z } from "zod";
//#region src/commands/setup.ts
const JsonRecordSchema = z.record(z.string(), z.unknown());
const agentWorkspaceModuleLoader = createLazyImportLoader(() => import("./workspace-DjjLeR_M.js"));
const configIOModuleLoader = createLazyImportLoader(() => import("./config/config.js"));
const configLoggingModuleLoader = createLazyImportLoader(() => import("./logging-CzCj0EHp.js"));
function loadAgentWorkspaceModule() {
	return agentWorkspaceModuleLoader.load();
}
function loadConfigIOModule() {
	return configIOModuleLoader.load();
}
function loadConfigLoggingModule() {
	return configLoggingModuleLoader.load();
}
async function createDefaultConfigIO() {
	const { createConfigIO } = await loadConfigIOModule();
	return createConfigIO();
}
async function resolveDefaultAgentWorkspaceDir(deps) {
	const override = deps.defaultAgentWorkspaceDir;
	if (typeof override === "string") return override;
	if (typeof override === "function") return await override();
	const { DEFAULT_AGENT_WORKSPACE_DIR } = await loadAgentWorkspaceModule();
	return DEFAULT_AGENT_WORKSPACE_DIR;
}
async function ensureDefaultAgentWorkspace(params) {
	const { ensureAgentWorkspace } = await loadAgentWorkspaceModule();
	return ensureAgentWorkspace(params);
}
async function writeDefaultConfigFile(config) {
	const { replaceConfigFile } = await loadConfigIOModule();
	await replaceConfigFile({
		nextConfig: config,
		afterWrite: { mode: "auto" }
	});
}
async function formatDefaultConfigPath(configPath) {
	const { formatConfigPath } = await loadConfigLoggingModule();
	return formatConfigPath(configPath);
}
async function logDefaultConfigUpdated(runtime, opts) {
	const { logConfigUpdated } = await loadConfigLoggingModule();
	logConfigUpdated(runtime, opts);
}
async function resolveDefaultSessionTranscriptsDir() {
	const { resolveSessionTranscriptsDir } = await import("./sessions-CyGKN95l.js");
	return resolveSessionTranscriptsDir();
}
async function readConfigFileRaw(configPath) {
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		return {
			exists: true,
			parsed: safeParseWithSchema(JsonRecordSchema, JSON5.parse(raw)) ?? {}
		};
	} catch {
		return {
			exists: false,
			parsed: {}
		};
	}
}
async function setupCommand(opts, runtime = defaultRuntime, deps = {}) {
	const desiredWorkspace = typeof opts?.workspace === "string" && opts.workspace.trim() ? opts.workspace.trim() : void 0;
	const configPath = (deps.createConfigIO?.() ?? await createDefaultConfigIO()).configPath;
	const existingRaw = await readConfigFileRaw(configPath);
	const cfg = existingRaw.parsed;
	const defaults = cfg.agents?.defaults ?? {};
	const workspace = desiredWorkspace ?? defaults.workspace ?? await resolveDefaultAgentWorkspaceDir(deps);
	const next = {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				workspace
			}
		},
		gateway: {
			...cfg.gateway,
			mode: cfg.gateway?.mode ?? "local"
		}
	};
	if (!existingRaw.exists || defaults.workspace !== workspace || cfg.gateway?.mode !== next.gateway?.mode) {
		await (deps.replaceConfigFile ?? ((params) => writeDefaultConfigFile(params.nextConfig)))({
			nextConfig: next,
			afterWrite: { mode: "auto" }
		});
		if (!existingRaw.exists) {
			const formatConfigPath = deps.formatConfigPath ?? formatDefaultConfigPath;
			runtime.log(`Wrote ${await formatConfigPath(configPath)}`);
		} else {
			const updates = [];
			if (defaults.workspace !== workspace) updates.push("set agents.defaults.workspace");
			if (cfg.gateway?.mode !== next.gateway?.mode) updates.push("set gateway.mode");
			const suffix = updates.length > 0 ? `(${updates.join(", ")})` : void 0;
			await (deps.logConfigUpdated ?? logDefaultConfigUpdated)(runtime, {
				path: configPath,
				suffix
			});
		}
	} else {
		const formatConfigPath = deps.formatConfigPath ?? formatDefaultConfigPath;
		runtime.log(`Config OK: ${await formatConfigPath(configPath)}`);
	}
	const ws = await (deps.ensureAgentWorkspace ?? ensureDefaultAgentWorkspace)({
		dir: workspace,
		ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
		skipOptionalBootstrapFiles: next.agents?.defaults?.skipOptionalBootstrapFiles
	});
	runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
	const sessionsDir = await (deps.resolveSessionTranscriptsDir ?? resolveDefaultSessionTranscriptsDir)();
	await (deps.mkdir ?? fs.mkdir)(sessionsDir, { recursive: true });
	runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
	runtime.log("");
	runtime.log("Setup complete: local config, workspace, and session directories are ready.");
	runtime.log(`Next: run ${formatCliCommand("openclaw configure")} to choose models, channels, Gateway, plugins, skills, and health checks.`);
	runtime.log(`For full first-run onboarding, run ${formatCliCommand("openclaw setup --wizard")}.`);
}
//#endregion
//#region src/cli/program/register.setup.ts
function registerSetupCommand(program) {
	program.command("setup").description("Initialize the active OpenClaw config and agent workspace").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`).option("--workspace <dir>", "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)").option("--wizard", "Run interactive onboarding", false).option("--non-interactive", "Run onboarding without prompts", false).option("--mode <mode>", "Onboard mode: local|remote").option("--import-from <provider>", "Migration provider to run during onboarding").option("--import-source <path>", "Source agent home for --import-from").option("--import-secrets", "Import supported secrets during onboarding migration", false).option("--remote-url <url>", "Remote Gateway WebSocket URL").option("--remote-token <token>", "Remote Gateway token (optional)").action(async (opts, command) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			const hasWizardFlags = hasExplicitOptions(command, [
				"wizard",
				"nonInteractive",
				"mode",
				"importFrom",
				"importSource",
				"importSecrets",
				"remoteUrl",
				"remoteToken"
			]);
			if (opts.wizard || hasWizardFlags) {
				await setupWizardCommand({
					workspace: opts.workspace,
					nonInteractive: Boolean(opts.nonInteractive),
					mode: opts.mode,
					importFrom: opts.importFrom,
					importSource: opts.importSource,
					importSecrets: Boolean(opts.importSecrets),
					remoteUrl: opts.remoteUrl,
					remoteToken: opts.remoteToken
				}, defaultRuntime);
				return;
			}
			await setupCommand({ workspace: opts.workspace }, defaultRuntime);
		});
	});
}
//#endregion
export { registerSetupCommand };
