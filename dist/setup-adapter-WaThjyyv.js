import "./account-id-B32J-iNN.js";
import "./routing-79DRZvfm.js";
import { D as patchTopLevelChannelConfigSection, Q as splitSetupEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import "./setup-DPvocg6M.js";
//#region extensions/nostr/src/default-relays.ts
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
//#endregion
//#region extensions/nostr/src/setup-adapter.ts
const channel = "nostr";
function buildNostrSetupPatch(accountId, patch) {
	return {
		...accountId !== "default" ? { defaultAccount: accountId } : {},
		...patch
	};
}
function parseRelayUrls(raw) {
	const relays = [];
	for (const entry of splitSetupEntries(raw)) {
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
function createNostrSetupAdapter(params) {
	return {
		resolveAccountId: ({ cfg, accountId }) => params.resolveAccountId(cfg, accountId),
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
				if (!params.validatePrivateKey(privateKey)) return "Nostr private key must be valid nsec or 64-character hex.";
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
}
//#endregion
export { DEFAULT_RELAYS as i, createNostrSetupAdapter as n, parseRelayUrls as r, buildNostrSetupPatch as t };
