import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-DLIxCAM0.js";
import { f as resolveRuntimePluginRegistry } from "./loader-DkTFEskE.js";
import { n as getActivePluginChannelRegistryVersion, t as getActivePluginChannelRegistry } from "./runtime-CFKT2mp_.js";
//#region src/infra/outbound/channel-bootstrap.runtime.ts
const bootstrapAttempts = /* @__PURE__ */ new Set();
function resetOutboundChannelBootstrapStateForTests() {
	bootstrapAttempts.clear();
}
function bootstrapOutboundChannelPlugin(params) {
	const cfg = params.cfg;
	if (!cfg) return;
	if (getActivePluginChannelRegistry()?.channels?.some((entry) => entry?.plugin?.id === params.channel)) return;
	const attemptKey = `${getActivePluginChannelRegistryVersion()}:${params.channel}`;
	if (bootstrapAttempts.has(attemptKey)) return;
	bootstrapAttempts.add(attemptKey);
	const autoEnabled = applyPluginAutoEnable({ config: cfg });
	const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
	const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
	try {
		resolveRuntimePluginRegistry({
			config: autoEnabled.config,
			activationSourceConfig: cfg,
			autoEnabledReasons: autoEnabled.autoEnabledReasons,
			workspaceDir,
			runtimeOptions: { allowGatewaySubagentBinding: true }
		});
	} catch {
		bootstrapAttempts.delete(attemptKey);
	}
}
//#endregion
export { resetOutboundChannelBootstrapStateForTests as n, bootstrapOutboundChannelPlugin as t };
