// Nostr plugin module implements nostr profile url safety behavior.
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";

export function normalizeNostrProfileUrlForRuntime(urlStr: string): string {
  // oxlint-disable-next-line no-warning-comments -- Keep the upstream removal condition beside the workaround.
  // TODO(oven-sh/WebKit#648): Remove after Bun accepts compressed IPv4-in-IPv6 URLs.
  return urlStr.replace(
    /^([a-z][a-z\d+.-]*:\/\/\[[\da-f:]*:)(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(\].*)$/iu,
    (original, prefix: string, a: string, b: string, c: string, d: string, suffix: string) => {
      const octets = [a, b, c, d].map(Number);
      if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
        return original;
      }
      const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
      const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
      return `${prefix}${high.toString(16)}:${low.toString(16)}${suffix}`;
    },
  );
}

function parseNostrProfileUrl(urlStr: string): URL {
  return new URL(normalizeNostrProfileUrlForRuntime(urlStr));
}

export function validateUrlSafety(urlStr: string): { ok: true } | { ok: false; error: string } {
  try {
    const url = parseNostrProfileUrl(urlStr);

    if (url.protocol !== "https:") {
      return { ok: false, error: "URL must use https:// protocol" };
    }

    const hostname = url.hostname.trim().toLowerCase();

    if (isBlockedHostnameOrIp(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
}
