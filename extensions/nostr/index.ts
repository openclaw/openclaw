import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "nostr",
  name: "Nostr",
  description: "Nostr DM channel plugin via NIP-04",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "nostrPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setNostrRuntime",
  },
  registerFull(api) {
    const { createNostrProfileHttpHandler, getNostrRuntime, resolveNostrAccount } =
      loadBundledEntryExportSync<typeof import("./api.js")>(import.meta.url, {
        specifier: "./api.js",
      });
    const httpHandler = createNostrProfileHttpHandler({
      getConfigProfile: (accountId) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.current();
        const account = resolveNostrAccount({ cfg, accountId });
        return account.profile;
      },
      updateConfigProfile: async (_accountId, profile) => {
        const runtime = getNostrRuntime();

        await runtime.config.mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            const channels = (draft.channels ?? {}) as Record<string, unknown>;
            const nostrConfig = (channels.nostr ?? {}) as Record<string, unknown>;

            draft.channels = {
              ...channels,
              nostr: {
                ...nostrConfig,
                profile,
              },
            };
          },
        });
      },
      getAccountInfo: (accountId) => {
        const runtime = getNostrRuntime();
        const cfg = runtime.config.current();
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
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: httpHandler,
    });
  },
});
