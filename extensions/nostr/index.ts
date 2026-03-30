import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { nostrPlugin } from "./src/channel.js";
import type { NostrProfile } from "./src/config-schema.js";
import { createNostrProfileHttpHandler } from "./src/nostr-profile-http.js";
import { getNostrRuntime, setNostrRuntime } from "./src/runtime.js";
import { resolveNostrAccount } from "./src/types.js";

export { nostrPlugin } from "./src/channel.js";
export { setNostrRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
	id: "nostr",
	name: "Nostr",
	description: "Nostr DM channel plugin via NIP-04",
	plugin: nostrPlugin,
	setRuntime: setNostrRuntime,
	registerFull(api) {
		const httpHandler = createNostrProfileHttpHandler({
			getConfigProfile: (accountId: string) => {
				const runtime = getNostrRuntime();
				const cfg = runtime.config.loadConfig();
				const account = resolveNostrAccount({ cfg, accountId });
				return account.profile;
			},
			updateConfigProfile: async (
				_accountId: string,
				profile: NostrProfile,
			) => {
				const runtime = getNostrRuntime();
				const cfg = runtime.config.loadConfig();

				const channels = (cfg.channels ?? {}) as Record<string, unknown>;
				const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;

				await runtime.config.writeConfigFile({
					...cfg,
					channels: {
						...channels,
						nostr: {
							...nostrConfig,
							profile,
						},
					},
				});
			},
			getAccountInfo: (accountId: string) => {
				const runtime = getNostrRuntime();
				const cfg = runtime.config.loadConfig();
				const account = resolveNostrAccount({ cfg, accountId });
				if (!account.configured || !account.publicKey) {
					return null;
				}
				return {
					pubkey: account.publicKey,
					relays: account.relays,
				};
			},
			log: api.logger,
		});

		api.registerHttpRoute({
			path: "/api/channels/nostr",
			auth: "gateway",
			match: "prefix",
			handler: httpHandler,
		});
	},
});
