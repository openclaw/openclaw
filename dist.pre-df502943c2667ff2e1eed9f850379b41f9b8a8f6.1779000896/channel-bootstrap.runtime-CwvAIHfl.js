import "./agent-scope-C5uhMtO-.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-BWnA6LIS.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-F7Wh4dvy.js";
import { f as resolveRuntimePluginRegistry } from "./loader-i-dc6V8W.js";
import { n as getActivePluginChannelRegistryVersion, t as getActivePluginChannelRegistry } from "./runtime-C5J6hl53.js";
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
