import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-B32J-iNN.js";
import { r as buildChannelConfigSchema } from "../../config-schema-CyiAUc5R.js";
import { n as describeAccountSnapshot } from "../../account-helpers-BEXOONiv.js";
import { t as createSetupTranslator } from "../../i18n-CWNhN747.js";
import { f as createStandardChannelSetupStatus } from "../../setup-wizard-helpers-CQhpROmW.js";
import { a as createDelegatedSetupWizardProxy } from "../../setup-wizard-proxy-Bf0n9XFS.js";
import "../../setup-runtime-NBriMroO.js";
import { t as NostrConfigSchema } from "../../config-schema-BumEusVj.js";
import { i as DEFAULT_RELAYS, n as createNostrSetupAdapter } from "../../setup-adapter-BTYphRiY.js";
//#region extensions/nostr/src/channel.setup.ts
const t = createSetupTranslator();
const channel = "nostr";
function getNostrConfig(cfg) {
	return cfg.channels?.nostr;
}
function listSetupNostrAccountIds(cfg) {
	const nostrCfg = getNostrConfig(cfg);
	if (!(typeof nostrCfg?.privateKey === "string" ? nostrCfg.privateKey.trim() : "")) return [];
	return [resolveDefaultSetupNostrAccountId(cfg)];
}
function resolveDefaultSetupNostrAccountId(cfg) {
	const configured = getNostrConfig(cfg)?.defaultAccount;
	return typeof configured === "string" && configured.trim() ? configured.trim() : DEFAULT_ACCOUNT_ID;
}
function resolveSetupNostrAccount(params) {
	const nostrCfg = getNostrConfig(params.cfg);
	const accountId = params.accountId?.trim() || resolveDefaultSetupNostrAccountId(params.cfg);
	const privateKey = typeof nostrCfg?.privateKey === "string" ? nostrCfg.privateKey.trim() : "";
	const configured = Boolean(privateKey);
	return {
		accountId,
		name: typeof nostrCfg?.name === "string" ? nostrCfg.name : void 0,
		enabled: nostrCfg?.enabled !== false,
		configured,
		privateKey,
		publicKey: "",
		relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
		profile: nostrCfg?.profile,
		config: {
			enabled: nostrCfg?.enabled,
			name: nostrCfg?.name,
			privateKey: nostrCfg?.privateKey,
			relays: nostrCfg?.relays,
			dmPolicy: nostrCfg?.dmPolicy,
			allowFrom: nostrCfg?.allowFrom,
			profile: nostrCfg?.profile
		}
	};
}
function looksLikeNostrPrivateKey(privateKey) {
	return privateKey.startsWith("nsec1") || /^[0-9a-fA-F]{64}$/.test(privateKey);
}
const nostrSetupAdapter = createNostrSetupAdapter({
	resolveAccountId: (cfg, accountId) => accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
	validatePrivateKey: looksLikeNostrPrivateKey
});
const nostrSetupWizard = createDelegatedSetupWizardProxy({
	channel,
	loadWizard: async () => (await import("../../setup-surface-D4npPEaH.js")).nostrSetupWizard,
	status: { ...createStandardChannelSetupStatus({
		channelLabel: "Nostr",
		configuredLabel: t("wizard.channels.statusConfigured"),
		unconfiguredLabel: t("wizard.channels.statusNeedsPrivateKey"),
		configuredHint: t("wizard.channels.statusConfigured"),
		unconfiguredHint: t("wizard.channels.statusNeedsPrivateKey"),
		configuredScore: 1,
		unconfiguredScore: 0,
		includeStatusLine: true,
		resolveConfigured: ({ cfg, accountId }) => resolveSetupNostrAccount({
			cfg,
			accountId
		}).configured,
		resolveExtraStatusLines: ({ cfg }) => {
			return [`Relays: ${resolveSetupNostrAccount({ cfg }).relays.length || DEFAULT_RELAYS.length}`];
		}
	}) },
	resolveShouldPromptAccountIds: () => false,
	delegatePrepare: true,
	delegateFinalize: true
});
const nostrSetupPlugin = {
	id: channel,
	meta: {
		id: channel,
		label: "Nostr",
		selectionLabel: "Nostr",
		docsPath: "/channels/nostr",
		docsLabel: "nostr",
		blurb: "Decentralized DMs via Nostr relays (NIP-04)",
		order: 100
	},
	capabilities: {
		chatTypes: ["direct"],
		media: false
	},
	reload: { configPrefixes: ["channels.nostr"] },
	configSchema: buildChannelConfigSchema(NostrConfigSchema),
	setup: nostrSetupAdapter,
	setupWizard: nostrSetupWizard,
	config: {
		listAccountIds: listSetupNostrAccountIds,
		resolveAccount: (cfg, accountId) => resolveSetupNostrAccount({
			cfg,
			accountId
		}),
		defaultAccountId: resolveDefaultSetupNostrAccountId,
		isConfigured: (account) => account.configured,
		describeAccount: (account) => describeAccountSnapshot({
			account,
			configured: account.configured,
			extra: { publicKey: account.publicKey }
		})
	}
};
//#endregion
export { nostrSetupPlugin };
