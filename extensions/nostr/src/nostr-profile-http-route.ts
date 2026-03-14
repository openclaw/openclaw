import type { OpenClawPluginApi } from "openclaw/plugin-sdk/nostr";
import type { NostrProfile } from "./config-schema.js";
import { createNostrProfileHttpHandler } from "./nostr-profile-http.js";
import { getNostrRuntime } from "./runtime.js";
import { resolveNostrAccount } from "./types.js";

let cachedHandler: ((req: unknown, res: unknown) => Promise<boolean | void>) | null = null;

function createHandler(api: OpenClawPluginApi) {
  return createNostrProfileHttpHandler({
    getConfigProfile: (accountId: string) => {
      const runtime = getNostrRuntime();
      const cfg = runtime.config.loadConfig();
      const account = resolveNostrAccount({ cfg, accountId });
      return account.profile;
    },
    updateConfigProfile: async (accountId: string, profile: NostrProfile) => {
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
}

export async function handleNostrProfileHttpRoute(
  req: unknown,
  res: unknown,
  api: OpenClawPluginApi,
): Promise<boolean | void> {
  cachedHandler ??= createHandler(api);
  return await cachedHandler(req, res);
}
