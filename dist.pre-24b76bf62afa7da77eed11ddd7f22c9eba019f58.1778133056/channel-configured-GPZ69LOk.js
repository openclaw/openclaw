import { c as isRecord } from "./utils-CCskKJVV.js";
import { t as getChannelEnvVars } from "./channel-env-vars-CZuXjAh-.js";
import { t as hasBundledChannelPackageState } from "./package-state-probes-CM3IH7Xh.js";
import { t as getBootstrapChannelPlugin } from "./bootstrap-registry-DHGuiWHx.js";
//#region src/channels/plugins/configured-state.ts
function hasBundledChannelConfiguredState(params) {
	return hasBundledChannelPackageState({
		metadataKey: "configuredState",
		channelId: params.channelId,
		cfg: params.cfg,
		env: params.env
	});
}
//#endregion
//#region src/config/channel-configured-shared.ts
function resolveChannelConfigRecord(cfg, channelId) {
	const entry = cfg.channels?.[channelId];
	return isRecord(entry) ? entry : null;
}
function hasMeaningfulChannelConfigShallow(value) {
	if (!isRecord(value)) return false;
	return Object.keys(value).some((key) => key !== "enabled");
}
function isStaticallyChannelConfigured(cfg, channelId, env = process.env) {
	for (const envVar of getChannelEnvVars(channelId, {
		config: cfg,
		env
	})) if (typeof env[envVar] === "string" && env[envVar].trim().length > 0) return true;
	return hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId));
}
//#endregion
//#region src/config/channel-configured.ts
function isChannelConfigured(cfg, channelId, env = process.env) {
	if (hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId))) return true;
	if (hasBundledChannelConfiguredState({
		channelId,
		cfg,
		env
	})) return true;
	const plugin = getBootstrapChannelPlugin(channelId);
	return Boolean(plugin?.config?.hasConfiguredState?.({
		cfg,
		env
	}));
}
//#endregion
export { isStaticallyChannelConfigured as n, isChannelConfigured as t };
