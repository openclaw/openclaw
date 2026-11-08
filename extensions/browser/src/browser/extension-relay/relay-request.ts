import type { IncomingMessage } from "node:http";
import { firstHeader } from "../http-auth.js";

export const LEGACY_EXTENSION_RELAY_PROTOCOL = "openclaw-extension-relay";
const LEGACY_EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX = "openclaw-extension-token.";

export function requestProtocols(req: IncomingMessage): string[] {
  return firstHeader(req.headers["sec-websocket-protocol"])
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function requestExtensionProtocolToken(req: IncomingMessage): string {
  const protocols = requestProtocols(req);
  if (!protocols.includes(LEGACY_EXTENSION_RELAY_PROTOCOL)) {
    return "";
  }
  const tokenProtocol = protocols.find((value) =>
    value.startsWith(LEGACY_EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX),
  );
  return tokenProtocol?.slice(LEGACY_EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX.length) ?? "";
}

export function isAllowedExtensionOrigin(req: IncomingMessage): boolean {
  const origin = firstHeader(req.headers.origin);
  return origin === "" || origin.startsWith("chrome-extension://");
}
