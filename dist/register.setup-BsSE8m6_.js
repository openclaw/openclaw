import { h as theme } from "./globals-DqM7Q4km.js";
import "./paths-BMo6kTge.js";
import { d as defaultRuntime } from "./subsystem-BXiL6bA6.js";
import "./boolean-DtWR5bt3.js";
import { G as writeConfigFile, R as createConfigIO } from "./auth-profiles-C39jSzPb.js";
import { E as ensureAgentWorkspace, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-BXg6mLAy.js";
import { x as shortenHomePath } from "./utils-xLjEf_5u.js";
import "./openclaw-root-CUjRHZhy.js";
import "./logger-hujp-3PD.js";
import "./exec-BpP6Q4EB.js";
import "./registry-DTmGzx3d.js";
import "./github-copilot-token-CvN6iidT.js";
import "./manifest-registry-YpcF6BWJ.js";
import "./version-cke7D5Ak.js";
import "./runtime-overrides-ChuaKEss.js";
import "./dock-CK-Sk5ak.js";
import "./message-channel-Uz3-Q9E0.js";
import "./sessions-Bx1XJLag.js";
import "./plugins-D8yPNTgi.js";
import "./accounts-C8pI_u-9.js";
import "./accounts-Cg8cGZPE.js";
import "./logging-CcxUDNcI.js";
import "./accounts-DBl2tRX-.js";
import { o as resolveSessionTranscriptsDir } from "./paths-DAWfoG1N.js";
import "./chat-envelope-D3RSz140.js";
import "./client-B-hNLzzd.js";
import "./call-Bwq3qM8o.js";
import "./pairing-token-BXrId5bQ.js";
import "./net-DAPyFre2.js";
import "./tailnet-D3NBwZ0q.js";
import "./redact-LEFt15z2.js";
import "./errors-8nIQWcYq.js";
import "./onboard-helpers-CaaiwG16.js";
import "./prompt-style-DsMXeXF9.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import { n as runCommandWithRuntime } from "./cli-utils-DWSfnwCw.js";
import "./progress-CAPOQFI0.js";
import { t as hasExplicitOptions } from "./command-options-CRvgER_f.js";
import "./note-BO75rWvI.js";
import "./clack-prompter-C4KtlrU1.js";
import "./runtime-guard-CtUjJshO.js";
import "./onboarding.secret-input-BiDIiXUU.js";
import "./onboarding-DLXBhEW6.js";
import { n as logConfigUpdated, t as formatConfigPath } from "./logging-rBFvUkzk.js";
import { t as onboardCommand } from "./onboard-ABYRJst0.js";
import "./onboard-config-RHUerEh1.js";
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