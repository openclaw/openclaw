import "../../provider-env-vars-BfZUtZAn.js";
import { bn as buildChannelConfigSchema } from "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import { Bt as resolveDefaultLineAccountId, Rt as listLineAccountIds, Vt as resolveLineAccount } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { n as lineSetupWizard, r as lineSetupAdapter, t as LineConfigSchema } from "../../line-iO245OTq.js";
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
