import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { nostrPlugin } from "./src/channel.js";
import type { NostrProfile } from "./src/config-schema.js";
import { createNostrProfileHttpHandler } from "./src/nostr-profile-http.js";
import { setNostrRuntime, getNostrRuntime } from "./src/runtime.js";
import { listNostrAccountIds, resolveNostrAccount } from "./src/types.js";

const plugin = {
  id: "nostr",
  name: "Nostr",
  description: "Nostr AI agent channel plugin via NIP-63 with NIP-44 encryption",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNostrRuntime(api.runtime);
    api.registerChannel({ plugin: nostrPlugin });

    // Register HTTP handler for profile management
    const httpHandler = createNostrProfileHttpHandler({
      getConfigProfile: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      updateConfigProfile: async (accountId: string, profile: NostrProfile) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const normalizedAccountId = normalizeAccountId(accountId);

        // Persist profile under channels.nostr.accounts.<accountId>.profile.
        // For default account we also mirror to channels.nostr.profile.
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;
        const existingAccounts =
          nostrConfig.accounts && typeof nostrConfig.accounts === "object"
            ? (nostrConfig.accounts as Record<string, unknown>)
            : {};
        const existingAccountEntry =
          existingAccounts[normalizedAccountId] &&
          typeof existingAccounts[normalizedAccountId] === "object"
            ? (existingAccounts[normalizedAccountId] as Record<string, unknown>)
            : {};

        const updatedNostrConfig = {
          ...nostrConfig,
          ...(normalizedAccountId === DEFAULT_ACCOUNT_ID ? { profile } : {}),
          accounts: {
            ...existingAccounts,
            [normalizedAccountId]: {
              ...existingAccountEntry,
              profile,
            },
          },
        };

        const updatedChannels = {
          ...channels,
          nostr: updatedNostrConfig,
        };

        await runtime.config.writeConfigFile({
          ...cfg,
          channels: updatedChannels,
        });
      },
      getAccountInfo: (accountId: string) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        const account = resolveNostrAccount({ cfg, accountId });
        if (!account.publicKey) {
          return null;
        }
        return {
          pubkey: account.publicKey,
          relays: account.relays,
          configured: account.configured,
          enabled: account.enabled,
          name: account.name,
          profile: account.profile,
        };
      },
      listAccountIds: () => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.loadConfig();
        return listNostrAccountIds(cfg);
      },
      log: api.logger,
    });

    api.registerHttpHandler(httpHandler);
  },
};

export default plugin;
