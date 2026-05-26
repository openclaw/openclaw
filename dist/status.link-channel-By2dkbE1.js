import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { t as resolveDefaultChannelAccountContext } from "./channel-account-context-CBt7HCPr.js";
//#region src/commands/status.link-channel.ts
async function resolveLinkChannelContext(cfg, options = {}) {
	const sourceConfig = options.sourceConfig ?? cfg;
	for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
		activationSourceConfig: sourceConfig,
		includeSetupFallbackPlugins: false
	})) {
		const { defaultAccountId, account, enabled, configured } = await resolveDefaultChannelAccountContext(plugin, cfg, {
			mode: "read_only",
			commandName: "status"
		});
		const snapshot = plugin.config.describeAccount ? plugin.config.describeAccount(account, cfg) : {
			accountId: defaultAccountId,
			enabled,
			configured
		};
		const summaryRecord = plugin.status?.buildChannelSummary ? await plugin.status.buildChannelSummary({
			account,
			cfg,
			defaultAccountId,
			snapshot
		}) : void 0;
		const linked = summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
		if (linked === null) continue;
		return {
			linked,
			authAgeMs: summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null,
			account,
			accountId: defaultAccountId,
			plugin
		};
	}
	return null;
}
//#endregion
export { resolveLinkChannelContext };
