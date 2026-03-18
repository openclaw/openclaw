import "../../provider-env-vars-BfZUtZAn.js";
import { v as normalizeAccountId } from "../../session-key-BSZsryCD.js";
import { Zn as buildChannelConfigSchema, f as getChatChannelMeta } from "../../resolve-route-CQsiaDZO.js";
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
import { Am as createScopedAccountConfigAccessors, Fa as resolveTelegramAccount, Gr as telegramSetupAdapter, Na as listTelegramAccountIds, Pa as resolveDefaultTelegramAccountId, Tp as TelegramConfigSchema, Wr as telegramSetupWizard, ja as inspectTelegramAccount, jm as createScopedChannelConfigBase, wt as formatAllowFromLowercase } from "../../auth-profiles-B70DPAVa.js";
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
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import "../../telegram-Dx47icNH.js";
//#region extensions/telegram/src/channel.setup.ts
function findTelegramTokenOwnerAccountId(params) {
	const normalizedAccountId = normalizeAccountId(params.accountId);
	const tokenOwners = /* @__PURE__ */ new Map();
	for (const id of listTelegramAccountIds(params.cfg)) {
		const account = inspectTelegramAccount({
			cfg: params.cfg,
			accountId: id
		});
		const token = (account.token ?? "").trim();
		if (!token) continue;
		const ownerAccountId = tokenOwners.get(token);
		if (!ownerAccountId) {
			tokenOwners.set(token, account.accountId);
			continue;
		}
		if (account.accountId === normalizedAccountId) return ownerAccountId;
	}
	return null;
}
function formatDuplicateTelegramTokenReason(params) {
	return `Duplicate Telegram bot token: account "${params.accountId}" shares a token with account "${params.ownerAccountId}". Keep one owner account per bot token.`;
}
const telegramConfigAccessors = createScopedAccountConfigAccessors({
	resolveAccount: ({ cfg, accountId }) => resolveTelegramAccount({
		cfg,
		accountId
	}),
	resolveAllowFrom: (account) => account.config.allowFrom,
	formatAllowFrom: (allowFrom) => formatAllowFromLowercase({
		allowFrom,
		stripPrefixRe: /^(telegram|tg):/i
	}),
	resolveDefaultTo: (account) => account.config.defaultTo
});
const telegramConfigBase = createScopedChannelConfigBase({
	sectionKey: "telegram",
	listAccountIds: listTelegramAccountIds,
	resolveAccount: (cfg, accountId) => resolveTelegramAccount({
		cfg,
		accountId
	}),
	inspectAccount: (cfg, accountId) => inspectTelegramAccount({
		cfg,
		accountId
	}),
	defaultAccountId: resolveDefaultTelegramAccountId,
	clearBaseFields: [
		"botToken",
		"tokenFile",
		"name"
	]
});
//#endregion
//#region extensions/telegram/setup-entry.ts
var setup_entry_default = { plugin: {
	id: "telegram",
	meta: {
		...getChatChannelMeta("telegram"),
		quickstartAllowFrom: true
	},
	setupWizard: telegramSetupWizard,
	capabilities: {
		chatTypes: [
			"direct",
			"group",
			"channel",
			"thread"
		],
		reactions: true,
		threads: true,
		media: true,
		polls: true,
		nativeCommands: true,
		blockStreaming: true
	},
	reload: { configPrefixes: ["channels.telegram"] },
	configSchema: buildChannelConfigSchema(TelegramConfigSchema),
	config: {
		...telegramConfigBase,
		isConfigured: (account, cfg) => {
			if (!account.token?.trim()) return false;
			return !findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			});
		},
		unconfiguredReason: (account, cfg) => {
			if (!account.token?.trim()) return "not configured";
			const ownerAccountId = findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			});
			if (!ownerAccountId) return "not configured";
			return formatDuplicateTelegramTokenReason({
				accountId: account.accountId,
				ownerAccountId
			});
		},
		describeAccount: (account, cfg) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: Boolean(account.token?.trim()) && !findTelegramTokenOwnerAccountId({
				cfg,
				accountId: account.accountId
			}),
			tokenSource: account.tokenSource
		}),
		...telegramConfigAccessors
	},
	setup: telegramSetupAdapter
} };
//#endregion
export { setup_entry_default as default };
