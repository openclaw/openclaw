import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/nostr";
import { nostrPlugin } from "./src/channel.js";
import { createNostrProfileHttpHandler } from "./src/nostr-profile-http.js";
import { setNostrRuntime, getNostrRuntime } from "./src/runtime.js";
import { resolveNostrAccount } from "./src/types.js";
const plugin = {
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setNostrRuntime(api.runtime);
    api.registerChannel({ plugin: nostrPlugin });
    const httpHandler = createNostrProfileHttpHandler({
      getConfigProfile: (accountId) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      updateConfigProfile: async (accountId, profile) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const channels = cfg.channels ?? {};
        const nostrConfig = channels.nostr ?? {};
        const updatedNostrConfig = {
          ...nostrConfig,
          profile
        };
        const updatedChannels = {
          ...channels,
          nostr: updatedNostrConfig
        };
        await runtime.config.writeConfigFile({
          ...cfg,
          channels: updatedChannels
        });
      },
      getAccountInfo: (accountId) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        if (!account.configured || !account.publicKey) {
          return null;
        }
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
      handler: httpHandler
    });
  }
};
var nostr_default = plugin;
export {
  nostr_default as default
};
