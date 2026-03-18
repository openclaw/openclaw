import "../../provider-env-vars-BfZUtZAn.js";
import { Zn as buildChannelConfigSchema } from "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import { Gt as resolveLineAccount, Ht as listLineAccountIds, Wt as resolveDefaultLineAccountId } from "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { n as lineSetupWizard, r as lineSetupAdapter, t as LineConfigSchema } from "../../line-DvbTO_h3.js";
//#region extensions/line/src/channel.setup.ts
const meta = {
	id: "line",
	label: "LINE",
	selectionLabel: "LINE (Messaging API)",
	detailLabel: "LINE Bot",
	docsPath: "/channels/line",
	docsLabel: "line",
	blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
	systemImage: "message.fill"
};
const normalizeLineAllowFrom = (entry) => entry.replace(/^line:(?:user:)?/i, "");
//#endregion
//#region extensions/line/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "line",
	meta: {
		...meta,
		quickstartAllowFrom: true
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		reactions: false,
		threads: false,
		media: true,
		nativeCommands: false,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.line"] },
	configSchema: buildChannelConfigSchema(LineConfigSchema),
	config: {
		listAccountIds: (cfg) => listLineAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveLineAccount({
			cfg,
			accountId: accountId ?? void 0
		}),
		defaultAccountId: (cfg) => resolveDefaultLineAccountId(cfg),
		isConfigured: (account) => Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim()),
			tokenSource: account.tokenSource ?? void 0
		}),
		resolveAllowFrom: ({ cfg, accountId }) => resolveLineAccount({
			cfg,
			accountId: accountId ?? void 0
		}).config.allowFrom,
		formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => normalizeLineAllowFrom(entry))
	},
	setupWizard: lineSetupWizard,
	setup: lineSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
