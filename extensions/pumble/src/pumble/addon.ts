import { setup } from "pumble-sdk";
import type { Addon, AddonManifest, CredentialsStore } from "pumble-sdk";
import type { ResolvedPumbleAccount } from "./accounts.js";

export const DEFAULT_WEBHOOK_PORT = 5111;

/**
 * Build a pumble-sdk AddonManifest from an OpenClaw Pumble account config.
 *
 * Requires appId, appKey, clientSecret, and signingSecret to be present.
 * Sets `socketMode: false` so the SDK starts an HTTP server for webhook events.
 * When `webhookBaseUrl` is provided, event subscription and redirect URLs are
 * configured to point at the public webhook endpoint.
 */
export function buildPumbleManifest(
  account: ResolvedPumbleAccount,
  webhookBaseUrl?: string,
): AddonManifest {
  if (!account.appId?.trim()) {
    throw new Error("Pumble appId is required for SDK mode");
  }
  if (!account.appKey?.trim()) {
    throw new Error("Pumble appKey is required for SDK mode");
  }
  if (!account.clientSecret?.trim()) {
    throw new Error("Pumble clientSecret is required for SDK mode");
  }
  if (!account.signingSecret?.trim()) {
    throw new Error("Pumble signingSecret is required for SDK mode");
  }

  const baseUrl = webhookBaseUrl?.replace(/\/+$/, "") ?? "";

  return {
    id: account.appId.trim(),
    socketMode: false,
    appKey: account.appKey.trim(),
    clientSecret: account.clientSecret.trim(),
    signingSecret: account.signingSecret.trim(),
    shortcuts: [] as const,
    slashCommands: [] as const,
    dynamicMenus: [] as const,
    redirectUrls: baseUrl ? [baseUrl + "/redirect"] : ([] as const),
    eventSubscriptions: {
      url: baseUrl ? baseUrl + "/hook" : "",
      events: ["NEW_MESSAGE" as const, "REACTION_ADDED" as const, "UPDATED_MESSAGE" as const],
    },
    scopes: {
      botScopes: [
        "messages:read",
        "messages:write",
        "channels:read",
        "channels:list",
        "user:read",
        "reaction:read",
        "reaction:write",
        "files:write",
      ],
      userScopes: [],
    },
  };
}

/**
 * Create a pumble-sdk Addon instance wired with an OcCredentialsStore.
 *
 * The returned Addon uses `socketMode: false` — calling `addon.start()` will
 * start an Express HTTP server on the given port to receive webhook events.
 */
export function createPumbleAddon(
  account: ResolvedPumbleAccount,
  credentialsStore: CredentialsStore,
  opts?: { webhookBaseUrl?: string; port?: number },
): Addon {
  const manifest = buildPumbleManifest(account, opts?.webhookBaseUrl);
  return setup(manifest, {
    serverPort: opts?.port ?? account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT,
    oauth2Config: {
      tokenStore: credentialsStore,
    },
  });
}
