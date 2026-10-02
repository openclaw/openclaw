import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  resolveBrowserConfig,
  resolveFirstExtensionProfileName,
  resolveProfile,
} from "./config.js";
import { ensureExtensionRelayToken } from "./extension-relay/relay-auth.js";

/** Gateway route for extension pairing that must wake Browser control. */
const GATEWAY_EXTENSION_RELAY_PATH = "/browser/extension";

type BrowserExtensionPairing = {
  pairingString: string;
  relayPort: number;
  topology: "local" | "browser-node" | "direct-remote";
};

/** Resolve a safe Gateway relay URL with the v2-bound route path. */
function buildGatewayExtensionRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("--gateway-url must be a valid ws:// or wss:// URL");
  }
  const secure = url.protocol === "wss:";
  const localPlaintext = url.protocol === "ws:" && isLoopbackHost(url.hostname);
  if (!secure && !localPlaintext) {
    throw new Error("--gateway-url must use wss:// (ws:// is allowed only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--gateway-url must not include credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error(
      "--gateway-url must not include a path prefix; Browser Relay Authentication v2 binds the exact /browser/extension path",
    );
  }
  url.pathname = GATEWAY_EXTENSION_RELAY_PATH;
  return url.toString();
}

/**
 * Build the canonical host-owned extension pairing used by both the CLI and
 * native bootstrap. A direct remote pairing is opt-in because its key belongs
 * to the remote Gateway rather than the browser host.
 */
export async function buildBrowserExtensionPairing(params: {
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  localTransport?: "relay" | "gateway";
  profile?: string;
  ensureToken?: typeof ensureExtensionRelayToken;
}): Promise<BrowserExtensionPairing> {
  const resolved = resolveBrowserConfig(params.cfg.browser, params.cfg);
  const profileName = params.profile || resolveFirstExtensionProfileName(resolved);
  const profile = profileName ? resolveProfile(resolved, profileName) : null;
  if (params.profile && profile?.driver !== "extension") {
    throw new Error("Native bootstrap requires an existing extension profile");
  }
  const relayPort = profile?.cdpPort ?? resolved.extensionRelayDefaultPort;
  const token = await (params.ensureToken ?? ensureExtensionRelayToken)();
  const gateway = params.gatewayUrl?.trim();
  if (gateway) {
    const relayUrl = new URL(buildGatewayExtensionRelayUrl(gateway));
    relayUrl.searchParams.set("gateway", gateway);
    return {
      pairingString: `${relayUrl.toString()}#${token}`,
      relayPort,
      topology: "direct-remote",
    };
  }

  const configuredRemote =
    params.cfg.gateway?.mode === "remote" ? params.cfg.gateway.remote?.url?.trim() : "";
  if (!configuredRemote && params.cfg.gateway?.tls?.enabled === true) {
    throw new Error("Gateway TLS pairing requires --gateway-url wss://<certificate-host>[:port]");
  }
  const gatewayHint = configuredRemote || `ws://127.0.0.1:${resolveGatewayPort(params.cfg)}`;
  // Native local bootstrap needs the Gateway to wake Browser control. Manual
  // local pairing and browser nodes target an already-running host relay.
  const relayUrl =
    !configuredRemote && params.localTransport === "gateway"
      ? new URL(buildGatewayExtensionRelayUrl(gatewayHint))
      : new URL(`ws://127.0.0.1:${relayPort}/extension`);
  if (params.profile && relayUrl.pathname === GATEWAY_EXTENSION_RELAY_PATH) {
    relayUrl.searchParams.set("profile", params.profile);
  }
  relayUrl.searchParams.set("gateway", gatewayHint);
  return {
    pairingString: `${relayUrl.toString()}#${token}`,
    relayPort,
    topology: configuredRemote ? "browser-node" : "local",
  };
}
