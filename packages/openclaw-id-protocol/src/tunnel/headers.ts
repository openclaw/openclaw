// Ingress header rules: what the tunnel child strips from client requests and what it adds.
import { bytesToHex, utf8 } from "../bytes.js";
import { sha256 } from "../crypto.js";
import type { IrohEndpointKey } from "../keys.js";
import { SYNTHETIC_PEER_PREFIX } from "./constants.js";
import type { HeaderPair } from "./types.js";

/** Hop-by-hop headers (RFC 9110 section 7.6.1) plus Host, which the proxy sets itself. */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "host",
] as const;

/** Identity headers a client must never be able to set toward the Gateway. */
export const CLIENT_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-email",
  "x-forwarded-groups",
  "x-forwarded-preferred-username",
  "x-openclaw-scopes",
  "remote-user",
  "x-remote-user",
  "x-real-ip",
] as const;

/** Header name prefixes stripped from client requests (forwarding and ingress-owned names). */
export const STRIPPED_HEADER_PREFIXES = [
  "x-forwarded-",
  "x-openclaw-id-",
  "x-tcid-",
  "cf-access-",
  "tailscale-",
] as const;

/** WebSocket handshake headers the upstream WebSocket client generates itself. */
export const WS_HANDSHAKE_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
] as const;

/**
 * Ingress contract headers set by the tunnel child on every proxied request (proposal;
 * the Gateway ingress contract owns the final names). The child passes the
 * authenticated peer key only; the Gateway maps it to a member through its own
 * membership state and decides scopes. The proxy token proves the request came
 * through the supervised child and not from another local process.
 */
export const INGRESS_HEADERS = {
  peerKey: "x-openclaw-id-peer-key",
  proxyToken: "x-openclaw-id-proxy-token",
  forwardedFor: "x-forwarded-for",
  forwardedProto: "x-forwarded-proto",
  forwardedHost: "x-forwarded-host",
} as const;

/** True when a client-supplied header must be removed before proxying. */
export function isStrippedRequestHeader(
  name: string,
  kind: "http" | "ws",
  connectionTokens: ReadonlySet<string> = new Set(),
): boolean {
  const lower = name.toLowerCase();
  return (
    (HOP_BY_HOP_HEADERS as readonly string[]).includes(lower) ||
    (CLIENT_IDENTITY_HEADERS as readonly string[]).includes(lower) ||
    connectionTokens.has(lower) ||
    lower === "forwarded" ||
    STRIPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    (kind === "ws" && (WS_HANDSHAKE_HEADERS as readonly string[]).includes(lower))
  );
}

/** Returns the client headers that survive stripping (names listed in Connection are stripped too). */
export function stripClientHeaders(headers: HeaderPair[], kind: "http" | "ws"): HeaderPair[] {
  const tokens = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) {
        tokens.add(token.trim().toLowerCase());
      }
    }
  }
  return headers.filter(([name]) => !isStrippedRequestHeader(name, kind, tokens));
}

/**
 * Stable synthetic IPv6 address for a device peer key, used as X-Forwarded-For so the
 * Gateway never sees a tunnel client as a loopback client: fd69:726f:6800::/48 plus the
 * first 80 bits of SHA-256(UTF-8 of the 64 hex digits). Same value as the spike ingress.
 */
export async function syntheticPeerAddress(peerKey: IrohEndpointKey): Promise<string> {
  const digest = bytesToHex(await sha256(utf8(peerKey.slice("iroh:".length))));
  const groups: string[] = [];
  for (let i = 0; i < 20; i += 4) {
    groups.push(Number.parseInt(digest.slice(i, i + 4), 16).toString(16));
  }
  return `${SYNTHETIC_PEER_PREFIX}:${groups.join(":")}`;
}
