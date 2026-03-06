import "./paths-BBP4yd-2.js";
import { h as theme } from "./globals-DBA9iEt5.js";
import { S as shortenHomePath } from "./utils-BgHhhQlR.js";
import { E as ensureAgentWorkspace, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-DcOd8osz.js";
import { d as defaultRuntime } from "./subsystem-B6NrUFrh.js";
import "./openclaw-root-rLmdSaR4.js";
import "./logger-JY9zcN88.js";
import "./exec-DOBmQ145.js";
import { Qt as createConfigIO, an as writeConfigFile } from "./model-selection-COYmqEoi.js";
import "./registry-DBb6KIXY.js";
import "./github-copilot-token-D9l3eOWF.js";
import "./boolean-C6Pbt2Ue.js";
import "./env-BfNMiMlQ.js";
import "./manifest-registry-BS8o_I_L.js";
import "./runtime-overrides-COUAbg1N.js";
import "./dock-D67Q8hqq.js";
import "./message-channel-BTTrmWeS.js";
import "./plugins-CVNXMV8f.js";
import "./sessions-DICryTKD.js";
import "./tailnet-ZGehJquv.js";
import "./ws-C0C8fn9j.js";
import "./redact-BIlIgsBb.js";
import "./errors-DRE3vN3Q.js";
import "./accounts-DXxZARtQ.js";
import "./accounts-Z1bz-0gv.js";
import "./logging-CZCkEw2g.js";
import "./accounts-RlQcOaUI.js";
import { o as resolveSessionTranscriptsDir } from "./paths-J0EFKbLQ.js";
import "./chat-envelope-BZKQmhVe.js";
import "./client-e8ddTB8a.js";
import "./call-D_7yp3J2.js";
import "./pairing-token-B9SSCi9X.js";
import "./onboard-helpers-DkoVky3L.js";
import "./prompt-style-D84-8NYI.js";
import { t as formatDocsLink } from "./links-DgCV6JAm.js";
import { n as runCommandWithRuntime } from "./cli-utils-CbnnSB38.js";
import "./progress-DLnu8mDe.js";
import "./runtime-guard-DSqWzr-M.js";
import { t as hasExplicitOptions } from "./command-options-DDDwkB9t.js";
import "./note-DLdhXOw1.js";
import "./clack-prompter-DDhkF4bu.js";
import "./onboarding.secret-input-DYRd72I4.js";
import "./onboarding-BoXraW9D.js";
import { n as logConfigUpdated, t as formatConfigPath } from "./logging-B-Y-xxir.js";
import { t as onboardCommand } from "./onboard-CxfMeO7v.js";
import "./onboard-config-QD4m66NV.js";
import JSON5 from "json5";
import fs from "node:fs/promises";

//#region src/commands/setup.ts
async function readConfigFileRaw(configPath) {
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object") return {
			exists: true,
			parsed
		};
		return {
			exists: true,
			parsed: {}
		};
	} catch {
		return {
			exists: false,
			parsed: {}
		};
	}
}
async function setupCommand(opts, runtime = defaultRuntime) {
	const desiredWorkspace = typeof opts?.workspace === "string" && opts.workspace.trim() ? opts.workspace.trim() : void 0;
	const configPath = createConfigIO().configPath;
	const existingRaw = await readConfigFileRaw(configPath);
	const cfg = existingRaw.parsed;
	const defaults = cfg.agents?.defaults ?? {};
	const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
	const next = {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				workspace
			}
		}
	};
	if (!existingRaw.exists || defaults.workspace !== workspace) {
		await writeConfigFile(next);
		if (!existingRaw.exists) runtime.log(`Wrote ${formatConfigPath(configPath)}`);
		else logConfigUpdated(runtime, {
			path: configPath,
			suffix: "(set agents.defaults.workspace)"
		});
	} else runtime.log(`Config OK: ${formatConfigPath(configPath)}`);
	const ws = await ensureAgentWorkspace({
		dir: workspace,
		ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap
	});
	runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
	const sessionsDir = resolveSessionTranscriptsDir();
	await fs.mkdir(sessionsDir, { recursive: true });
	runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}

//#endregion
//#region src/cli/program/register.setup.ts
function registerSetupCommand(program) {
	program.command("setup").description("Initialize ~/.openclaw/openclaw.json and the agent workspace").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`).option("--workspace <dir>", "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)").option("--wizard", "Run the interactive onboarding wizard", false).option("--non-interactive", "Run the wizard without prompts", false).option("--mode <mode>", "Wizard mode: local|remote").option("--remote-url <url>", "Remote Gateway WebSocket URL").option("--remote-token <token>", "Remote Gateway token (optional)").action(async (opts, command) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			const hasWizardFlags = hasExplicitOptions(command, [
				"wizard",
				"nonInteractive",
				"mode",
				"remoteUrl",
				"remoteToken"
			]);
			if (opts.wizard || hasWizardFlags) {
				await onboardCommand({
					workspace: opts.workspace,
					nonInteractive: Boolean(opts.nonInteractive),
					mode: opts.mode,
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