import "./agent-scope-wct0i6B_.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-BuKrT2wm.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-C8t9y5Vn.js";
import { d as resolveRuntimePluginRegistry } from "./loader-Cq-u8i4x.js";
import { n as getActivePluginChannelRegistryVersion, t as getActivePluginChannelRegistry } from "./runtime-CuTYW44m.js";
//#region src/infra/outbound/channel-bootstrap.runtime.ts
const bootstrapAttempts = /* @__PURE__ */ new Set();
function resetOutboundChannelBootstrapStateForTests() {
	bootstrapAttempts.clear();
}
function channelEntryCanSend(entry) {
	return Boolean(entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text);
}
function bootstrapOutboundChannelPlugin(params) {
	const cfg = params.cfg;
	if (!cfg) return;
	const activeChannelEntry = getActivePluginChannelRegistry()?.channels?.find((entry) => entry?.plugin?.id === params.channel);
	if (channelEntryCanSend(activeChannelEntry)) return;
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
