import "./paths-BJV7vkaX.js";
import { t as createSubsystemLogger } from "./subsystem-DBBM_0ww.js";
import "./utils-JhJvOE-Q.js";
import { V as loadOpenClawPlugins, x_ as loadConfig } from "./reply-kqyKJg4x.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-BwZuo7sQ.js";
import "./openclaw-root-CGu4EGX8.js";
import "./logger-B7cfoxgB.js";
import "./exec-eWx7-KTZ.js";
import "./github-copilot-token-DLfBlMRf.js";
import "./boolean-B938tROv.js";
import "./env-Cb5JzEB2.js";
import "./env-overrides-C-ZXrJon.js";
import "./registry-BbhZ8aJW.js";
import "./skills-3AC6GJLt.js";
import "./frontmatter-BngyYhS0.js";
import "./plugins-By9GTgrF.js";
import "./query-expansion-yWVZ1kDa.js";
import "./redact-ey2aG4c9.js";
import "./path-alias-guards-Cb4NBV2_.js";
import "./fetch-pr82VtKF.js";
import "./cli-utils-DMoIioWo.js";
import "./delivery-queue-DFrlUHFS.js";
import "./paths-DtZZPyOl.js";
import "./session-cost-usage-CUa3Yrhb.js";
import "./prompt-style-DxRe6Qmy.js";
import "./links-D5--5M_8.js";
//#region src/plugins/cli.ts
const log = createSubsystemLogger("plugins");
function registerPluginCliCommands(program, cfg, env) {
	const config = cfg ?? loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const logger = {
		info: (msg) => log.info(msg),
		warn: (msg) => log.warn(msg),
		error: (msg) => log.error(msg),
		debug: (msg) => log.debug(msg)
	};
	const registry = loadOpenClawPlugins({
		config,
		workspaceDir,
		env,
		logger
	});
	const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));
	for (const entry of registry.cliRegistrars) {
		if (entry.commands.length > 0) {
			const overlaps = entry.commands.filter((command) => existingCommands.has(command));
			if (overlaps.length > 0) {
				log.debug(`plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(", ")})`);
				continue;
			}
		}
		try {
			const result = entry.register({
				program,
				config,
				workspaceDir,
				logger
			});
			if (result && typeof result.then === "function") result.catch((err) => {
				log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
			});
			for (const command of entry.commands) existingCommands.add(command);
		} catch (err) {
			log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
		}
	}
}
//#endregion
export { registerPluginCliCommands };
