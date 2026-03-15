import "../../provider-env-vars-BfZUtZAn.js";
import { g as normalizeAccountId } from "../../session-key-BfFG0xOA.js";
import { bn as buildChannelConfigSchema, m as getChatChannelMeta } from "../../resolve-route-BZ4hHpx2.js";
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
import { Hr as telegramSetupAdapter, Vr as telegramSetupWizard, _a as listTelegramAccountIds, bt as formatAllowFromLowercase, ga as inspectTelegramAccount, va as resolveDefaultTelegramAccountId, vf as TelegramConfigSchema, vp as createScopedAccountConfigAccessors, ya as resolveTelegramAccount, yp as createScopedChannelConfigBase } from "../../auth-profiles-CuJtivJK.js";
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
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import "../../telegram-D9FeracA.js";
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
