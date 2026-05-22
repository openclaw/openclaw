import { u as createTopLevelChannelConfigAdapter } from "../../channel-config-helpers-DW4DAoO6.js";
import { n as describeAccountSnapshot } from "../../account-helpers-CrOaP9VG.js";
import { t as formatAllowFromLowercase } from "../../allow-from-DvljLCfr.js";
import { h as resolveMSTeamsCredentials } from "../../graph-users-Bql42zEJ.js";
import { t as MSTeamsChannelConfigSchema } from "../../config-schema-Dd02_Ke_.js";
import { i as msteamsSetupAdapter, t as msteamsSetupWizard } from "../../setup-surface-DCFs4JPm.js";
//#region extensions/msteams/src/channel.setup.ts
const meta = {
	id: "msteams",
	label: "Microsoft Teams",
	selectionLabel: "Microsoft Teams (Bot Framework)",
	docsPath: "/channels/msteams",
	docsLabel: "msteams",
	blurb: "Teams SDK; enterprise support.",
	aliases: ["teams"],
	order: 60
};
const resolveMSTeamsChannelConfig = (cfg) => ({
	allowFrom: cfg.channels?.msteams?.allowFrom,
	defaultTo: cfg.channels?.msteams?.defaultTo
});
const msteamsConfigAdapter = createTopLevelChannelConfigAdapter({
	sectionKey: "msteams",
	resolveAccount: (cfg) => ({
		accountId: "default",
		enabled: cfg.channels?.msteams?.enabled !== false,
		configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams))
	}),
	resolveAccessorAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
	resolveDefaultTo: (account) => account.defaultTo
});
const msteamsSetupPlugin = {
	id: "msteams",
	meta: {
		...meta,
		aliases: [...meta.aliases]
	},
	capabilities: {
		chatTypes: [
			"direct",
			"channel",
			"thread"
		],
		polls: true,
		threads: true,
		media: true
	},
	reload: { configPrefixes: ["channels.msteams"] },
	configSchema: MSTeamsChannelConfigSchema,
	config: {
		...msteamsConfigAdapter,
		isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
		describeAccount: (account) => describeAccountSnapshot({
			account,
			configured: account.configured
		})
	},
	setupWizard: msteamsSetupWizard,
	setup: msteamsSetupAdapter
};
//#endregion
export { msteamsSetupPlugin };
