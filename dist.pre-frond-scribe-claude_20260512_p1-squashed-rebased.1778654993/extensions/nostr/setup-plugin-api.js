import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import { r as buildChannelConfigSchema } from "../../config-schema-bYjGMbfy.js";
import { n as describeAccountSnapshot } from "../../account-helpers-DbwGonJj.js";
import { D as patchTopLevelChannelConfigSection, f as createStandardChannelSetupStatus } from "../../setup-wizard-helpers-CqHo9ArT.js";
import { a as createDelegatedSetupWizardProxy } from "../../setup-wizard-proxy-rc7pXz-s.js";
import "../../setup-DsFVj4-e.js";
import "../../setup-runtime-s0Npqw-g.js";
import { t as NostrConfigSchema } from "../../config-schema-BFIQc4Ty.js";
import { t as DEFAULT_RELAYS } from "../../default-relays-BnCpahYi.js";
//#region extensions/nostr/src/channel.setup.ts
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
function buildNostrSetupPatch(accountId, patch) {
	return {
		...accountId !== "default" ? { defaultAccount: accountId } : {},
		...patch
	};
}
function parseRelayUrls(raw) {
	const entries = raw.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
	const relays = [];
	for (const entry of entries) {
		try {
			const parsed = new URL(entry);
			if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return {
				relays: [],
				error: `Relay must use ws:// or wss:// (${entry})`
			};
		} catch {
			return {
				relays: [],
				error: `Invalid relay URL: ${entry}`
			};
		}
		relays.push(entry);
	}
	return { relays: [...new Set(relays)] };
}
function looksLikeNostrPrivateKey(privateKey) {
	return privateKey.startsWith("nsec1") || /^[0-9a-fA-F]{64}$/.test(privateKey);
}
const nostrSetupAdapter = {
	resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultSetupNostrAccountId(cfg),
	applyAccountName: ({ cfg, accountId, name }) => patchTopLevelChannelConfigSection({
		cfg,
		channel,
		patch: buildNostrSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {})
	}),
	validateInput: ({ input }) => {
		const typedInput = input;
		if (!typedInput.useEnv) {
			const privateKey = typedInput.privateKey?.trim();
			if (!privateKey) return "Nostr requires --private-key or --use-env.";
			if (!looksLikeNostrPrivateKey(privateKey)) return "Nostr private key must be valid nsec or 64-character hex.";
		}
		if (typedInput.relayUrls?.trim()) return parseRelayUrls(typedInput.relayUrls).error ?? null;
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const typedInput = input;
		const relayResult = typedInput.relayUrls?.trim() ? parseRelayUrls(typedInput.relayUrls) : { relays: [] };
		return patchTopLevelChannelConfigSection({
			cfg,
			channel,
			enabled: true,
			clearFields: typedInput.useEnv ? ["privateKey"] : void 0,
			patch: buildNostrSetupPatch(accountId, {
				...typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() },
				...relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}
			})
		});
	}
};
const nostrSetupWizard = createDelegatedSetupWizardProxy({
	channel,
	loadWizard: async () => (await import("../../setup-surface-Br8-G9PQ.js")).nostrSetupWizard,
	status: { ...createStandardChannelSetupStatus({
		channelLabel: "Nostr",
		configuredLabel: "configured",
		unconfiguredLabel: "needs private key",
		configuredHint: "configured",
		unconfiguredHint: "needs private key",
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
