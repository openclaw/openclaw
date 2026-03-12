import "./paths-B4BZAPZh.js";
import { B as theme, S as shortenHomePath } from "./utils-BKDT474X.js";
import { E as ensureAgentWorkspace, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-D8K2SjR7.js";
import { f as defaultRuntime } from "./subsystem-LTWJBEIv.js";
import "./openclaw-root-PhSD0wUu.js";
import "./exec-NrPPwdAe.js";
import { Gt as writeConfigFile, Rt as createConfigIO } from "./model-selection-DILdVnl8.js";
import "./github-copilot-token-nncItI8D.js";
import "./boolean-Wzu0-e0P.js";
import "./env-BqIeOdP-.js";
import "./host-env-security-lcjXF83D.js";
import "./env-vars-Duxu9t5m.js";
import "./manifest-registry-BvFf4Q1K.js";
import "./dock-C2VnAw6v.js";
import "./message-channel-C0KMGsnJ.js";
import "./ip-DK-vcRii.js";
import "./tailnet-kbXXH7kK.js";
import "./ws-zZ6eXqMi.js";
import "./redact-B76y7XVG.js";
import "./errors-8IxbaLwV.js";
import "./sessions-DUzDEcXs.js";
import "./plugins-B9xwwhdE.js";
import "./accounts-BDIC1FjT.js";
import "./accounts-Lsgq7_wm.js";
import "./accounts-DzNOa1lz.js";
import "./bindings-DXaMWXSi.js";
import "./logging-_TuF9Wz5.js";
import { s as resolveSessionTranscriptsDir } from "./paths-B_bX6Iw-.js";
import "./chat-envelope-CZCr0x5F.js";
import "./client-xAUDLDK2.js";
import "./call-BP56BqJF.js";
import "./pairing-token-BdLe8Jtz.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { n as runCommandWithRuntime } from "./cli-utils-CzIyxbam.js";
import "./progress-_rXhKU7V.js";
import "./onboard-helpers-C3I-0jon.js";
import "./prompt-style-CQUEv9Gp.js";
import "./runtime-guard-C-Xp_TV0.js";
import { t as hasExplicitOptions } from "./command-options-Duxj7LwL.js";
import "./note-DcEdE35k.js";
import "./clack-prompter-BhiWipMQ.js";
import "./onboarding-D0qnDKuc.js";
import { n as logConfigUpdated, t as formatConfigPath } from "./logging-dewsWJU6.js";
import { t as onboardCommand } from "./onboard-BEODZlDq.js";
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