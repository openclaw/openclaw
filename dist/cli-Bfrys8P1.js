import "./paths-BBP4yd-2.js";
import "./globals-DBA9iEt5.js";
import "./utils-BgHhhQlR.js";
import "./thinking-44rmAw5o.js";
import { ft as loadOpenClawPlugins } from "./reply-CtQMdhNT.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-DcOd8osz.js";
import { t as createSubsystemLogger } from "./subsystem-B6NrUFrh.js";
import "./openclaw-root-rLmdSaR4.js";
import "./logger-JY9zcN88.js";
import "./exec-DOBmQ145.js";
import { $t as loadConfig } from "./model-selection-COYmqEoi.js";
import "./registry-DBb6KIXY.js";
import "./github-copilot-token-D9l3eOWF.js";
import "./boolean-C6Pbt2Ue.js";
import "./env-BfNMiMlQ.js";
import "./manifest-registry-BS8o_I_L.js";
import "./runtime-overrides-COUAbg1N.js";
import "./dock-D67Q8hqq.js";
import "./message-channel-BTTrmWeS.js";
import "./send-BPCJUran.js";
import "./plugins-CVNXMV8f.js";
import "./sessions-DICryTKD.js";
import "./audio-transcription-runner-GMqQalEp.js";
import "./image-D86azZkZ.js";
import "./models-config-D6yWFKHl.js";
import "./pi-embedded-helpers-4c583e5O.js";
import "./sandbox-B99_qo5_.js";
import "./tool-catalog-IBWCA-2a.js";
import "./chrome-BHZCnUQK.js";
import "./tailscale-CuFyx_x9.js";
import "./tailnet-ZGehJquv.js";
import "./ws-C0C8fn9j.js";
import "./auth-_bAG6RXt.js";
import "./server-context-BAtMECx_.js";
import "./frontmatter-DobVhJLD.js";
import "./skills-DOWW7Nlf.js";
import "./path-alias-guards-DHN0MYP9.js";
import "./paths-L5nChQ8H.js";
import "./redact-BIlIgsBb.js";
import "./errors-DRE3vN3Q.js";
import "./fs-safe-CAprtaTc.js";
import "./proxy-env-B4mNR5H5.js";
import "./image-ops-_Momh5Q_.js";
import "./store-B8nZst-N.js";
import "./ports-dE92jbnn.js";
import "./trash-CJfp7H-I.js";
import "./server-middleware-DaRy-OMg.js";
import "./accounts-DXxZARtQ.js";
import "./accounts-Z1bz-0gv.js";
import "./logging-CZCkEw2g.js";
import "./accounts-RlQcOaUI.js";
import "./send-BpB4S-W5.js";
import "./paths-J0EFKbLQ.js";
import "./chat-envelope-BZKQmhVe.js";
import "./tool-images-CxRDpS1l.js";
import "./tool-display-oPtLgvHX.js";
import "./fetch-guard-DNVP4AD6.js";
import "./api-key-rotation-fBrWbbU-.js";
import "./local-roots-BGOsLcJv.js";
import "./model-catalog-Asyj36Mm.js";
import "./proxy-fetch-D-ERJUt-.js";
import "./tokens-4Dj4pceq.js";
import "./deliver-5ddKxsNG.js";
import "./commands-BrTU55I1.js";
import "./commands-registry-CexZteuq.js";
import "./client-e8ddTB8a.js";
import "./call-D_7yp3J2.js";
import "./pairing-token-B9SSCi9X.js";
import "./fetch-B-cRjAga.js";
import "./pairing-store-BPuMMpmS.js";
import "./exec-approvals-CHqqI6K9.js";
import "./exec-approvals-allowlist-DuZWR59J.js";
import "./exec-safe-bin-runtime-policy-CftZiuzx.js";
import "./nodes-screen-BBZw4JyZ.js";
import "./target-errors-DrCLlzmW.js";
import "./system-run-command-BeTbPoZc.js";
import "./diagnostic-B74_k7yR.js";
import "./with-timeout-C6al15_g.js";
import "./send-D6eKPjZK.js";
import "./model-DaYWTFLZ.js";
import "./pi-model-discovery-Btdks6K9.js";
import "./ir-uwbSpW7L.js";
import "./render-K7NwXvVu.js";
import "./channel-selection-DgM4Lbyb.js";
import "./plugin-auto-enable-CVWTnFKP.js";
import "./send-B7BgbN_b.js";
import "./outbound-attachment-DpPg9Q8O.js";
import "./delivery-queue-y-ZMXS4i.js";
import "./send-BYNLaY-L.js";
import "./pi-tools.policy-DFWiya6o.js";
import "./channel-activity-DV8HOgBT.js";
import "./tables-D5AiFFqY.js";
import "./proxy-CZ-7bxaR.js";
import "./skill-commands-LjJpoiJc.js";
import "./workspace-dirs-72_XJMb0.js";
import "./runtime-config-collectors-B1e_OiHD.js";
import "./command-secret-targets-OLgKF2ja.js";
import "./session-cost-usage-B8HS2Edq.js";
import "./onboard-helpers-DkoVky3L.js";
import "./prompt-style-D84-8NYI.js";
import "./pairing-labels-DbGzKon0.js";
import "./memory-cli-DgQ-NUC0.js";
import "./manager-CzTvVvPx.js";
import "./query-expansion-BC5HdhFv.js";
import "./links-DgCV6JAm.js";
import "./cli-utils-CbnnSB38.js";
import "./help-format-CHibOmDT.js";
import "./progress-DLnu8mDe.js";
import "./server-lifecycle-BgggQ9M5.js";
import "./stagger-RKJcYQbS.js";

//#region src/plugins/cli.ts
const log = createSubsystemLogger("plugins");
function registerPluginCliCommands(program, cfg) {
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