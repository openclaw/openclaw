import { r as loadBundledEntryExportSync, t as defineBundledChannelEntry } from "../../channel-entry-contract-DJgUK72T.js";
//#region extensions/nostr/index.ts
function createNostrProfileHttpHandler() {
	return loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "createNostrProfileHttpHandler"
	});
}
function getNostrRuntime() {
	return loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "getNostrRuntime"
	})();
}
function resolveNostrAccount(params) {
	return loadBundledEntryExportSync(import.meta.url, {
		specifier: "./api.js",
		exportName: "resolveNostrAccount"
	})(params);
}
var nostr_default = defineBundledChannelEntry({
	id: "nostr",
	name: "Nostr",
	description: "Nostr DM channel plugin via NIP-04",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "nostrPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setNostrRuntime"
	},
	registerFull(api) {
		const httpHandler = createNostrProfileHttpHandler()({
			getConfigProfile: (accountId) => {
				return resolveNostrAccount({
					cfg: getNostrRuntime().config.current(),
					accountId
				}).profile;
			},
			updateConfigProfile: async (accountId, profile) => {
				const runtime = getNostrRuntime();
				const cfg = runtime.config.current();
				const channels = cfg.channels ?? {};
				const nostrConfig = channels.nostr ?? {};
				await runtime.config.replaceConfigFile({
					nextConfig: {
						...cfg,
						channels: {
							...channels,
							nostr: {
								...nostrConfig,
								profile
							}
						}
					},
					afterWrite: { mode: "auto" }
				});
			},
			getAccountInfo: (accountId) => {
				const account = resolveNostrAccount({
					cfg: getNostrRuntime().config.current(),
					accountId
				});
				if (!account.configured || !account.publicKey) return null;
				return {
					pubkey: account.publicKey,
					relays: account.relays
				};
			},
			log: api.logger
		});
		api.registerHttpRoute({
			path: "/api/channels/nostr",
			auth: "gateway",
			match: "prefix",
			gatewayRuntimeScopeSurface: "trusted-operator",
			handler: httpHandler
		});
	}
});
//#endregion
export { nostr_default as default };
