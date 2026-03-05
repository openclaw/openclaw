import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";

export function rawDataToString(data, encoding = "utf8") {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString(encoding);
  if (Array.isArray(data)) return Buffer.concat(data).toString(encoding);
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString(encoding);
  return Buffer.from(String(data)).toString(encoding);
}

export function isLoopbackAddress(ip) {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
}

export function isLoopbackHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().trim();
  return h === "localhost" || isLoopbackAddress(h) || h === "[::1]";
}

export function resolveRelayAuthTokenForPort(port) {
  const gatewayToken = process.env.MCP_WEB_ADAPTER_TOKEN || "default-token";
  return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

export function resolveRelayAcceptedTokensForPort(port) {
  const token = resolveRelayAuthTokenForPort(port);
  const gatewayToken = process.env.MCP_WEB_ADAPTER_TOKEN;
  return gatewayToken ? [token, gatewayToken] : [token];
}
