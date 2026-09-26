import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";

function parseIpLiteral(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const candidate = trimmed.slice(1, end);
      return net.isIP(candidate) === 0 ? undefined : candidate;
    }
  }
  if (net.isIP(trimmed) !== 0) {
    return trimmed;
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > -1 && trimmed.includes(".") && trimmed.indexOf(":") === lastColon) {
    const candidate = trimmed.slice(0, lastColon);
    return net.isIP(candidate) === 4 ? candidate : undefined;
  }
  return undefined;
}

// Preserve v2026.9.6 auth-failure buckets; these addresses never grant Gateway authority.
export function createTelegramLegacyWebhookAuthLimiter(config: OpenClawConfig | undefined) {
  const rateLimiter = createFixedWindowRateLimiter(WEBHOOK_RATE_LIMIT_DEFAULTS);
  const trusted = new net.BlockList();
  for (const proxy of config?.gateway?.trustedProxies ?? []) {
    const value = proxy.trim();
    const [address = "", prefix] = value.split("/", 2);
    if (prefix !== undefined) {
      const bits = parseStrictNonNegativeInteger(prefix);
      const family = net.isIP(address);
      if (bits !== undefined && family === 4 && bits <= 32) {
        trusted.addSubnet(address, bits, "ipv4");
      } else if (bits !== undefined && family === 6 && bits <= 128) {
        trusted.addSubnet(address, bits, "ipv6");
      }
    } else if (net.isIP(value) === 4) {
      trusted.addAddress(value, "ipv4");
    } else if (net.isIP(value) === 6) {
      trusted.addAddress(value, "ipv6");
    }
  }
  const isTrusted = (ip: string) => trusted.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");
  const headerValue = (header: string | string[] | undefined) =>
    Array.isArray(header) ? header[0] : header;
  const clientIp = (req: IncomingMessage): string => {
    const remote = parseIpLiteral(req.socket.remoteAddress);
    if (!remote) {
      return "unknown";
    }
    if (!isTrusted(remote)) {
      return remote;
    }
    const forwarded = headerValue(req.headers["x-forwarded-for"])
      ?.split(",")
      .map(parseIpLiteral)
      .filter((ip) => ip !== undefined);
    for (const hop of forwarded?.toReversed() ?? []) {
      // Shipped Telegram ports count an untrusted loopback hop rather than
      // applying the Gateway's stricter forwarded-identity selection.
      if (!isTrusted(hop)) {
        return hop;
      }
    }
    return config?.gateway?.allowRealIpFallback === true
      ? (parseIpLiteral(headerValue(req.headers["x-real-ip"])) ?? "unknown")
      : "unknown";
  };
  return (req: IncomingMessage, res: ServerResponse) =>
    applyBasicWebhookRequestGuards({
      req,
      res,
      rateLimiter,
      rateLimitKey: `${req.url}:${clientIp(req)}`,
    });
}
