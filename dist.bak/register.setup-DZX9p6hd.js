import { Ot as theme, ut as shortenHomePath, v as defaultRuntime } from "./entry.js";
import { A as createConfigIO, L as writeConfigFile } from "./auth-profiles-D6H-HVV8.js";
import { E as ensureAgentWorkspace, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./dock-B6idJaIX.js";
import "./message-channel-CJUwnCYd.js";
import "./sessions-B8Y6oyPb.js";
import "./plugins-BOmV0yTv.js";
import "./accounts-jTTYYc3C.js";
import "./accounts-CnxuiQaw.js";
import "./accounts-DKgW2m_s.js";
import "./bindings-DcFNU_QL.js";
import "./logging-Cr3Gsq0-.js";
import { s as resolveSessionTranscriptsDir } from "./paths-DWsXK0S0.js";
import "./chat-envelope-CrHAOMhr.js";
import "./client-C2kv9X_7.js";
import "./call-D6IYi30Z.js";
import "./pairing-token-DzfCmsrM.js";
import "./net-DBrsyv8q.js";
import "./ip-BDxIP8rd.js";
import "./tailnet-Ca1WnFBq.js";
import "./redact-Dcypez3H.js";
import "./errors-Cu3BYw29.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { n as runCommandWithRuntime } from "./cli-utils-CKDCmKAq.js";
import "./progress-bvyZjsUc.js";
import "./onboard-helpers-CijgoJ1t.js";
import "./prompt-style-wsroINzm.js";
import { t as hasExplicitOptions } from "./command-options-BtDai3oC.js";
import "./note-DQ26Rw8p.js";
import "./clack-prompter-b-zJxplB.js";
import "./runtime-guard-jjhyM3bE.js";
import "./onboarding-C7wlGNih.js";
import { n as logConfigUpdated, t as formatConfigPath } from "./logging-Bi2fXy2a.js";
import { t as onboardCommand } from "./onboard-CF_yFouK.js";
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