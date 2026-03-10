/**
 * Browser URL validation for the exec-browser path.
 *
 * Prevents SSRF attacks by blocking dangerous protocols, metadata endpoints,
 * loopback addresses, and private IP ranges before URLs are sent to containers.
 */

const BLOCKED_PROTOCOLS = new Set([
  "file:",
  "chrome:",
  "chrome-extension:",
  "data:",
  "javascript:",
  "vbscript:",
]);

const BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP metadata
  "fd00:ec2::254", // AWS IPv6 metadata
  "100.100.100.200", // Alibaba Cloud metadata
  "metadata.google.internal", // GCP metadata hostname
]);

/** Private/loopback IP prefixes for quick string-based check. */
const PRIVATE_PREFIXES = ["127.", "10.", "0."];

/**
 * Convert a 32-bit integer to a dotted-quad IPv4 string.
 */
function intToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * Check if a hostname is a private or loopback IP address.
 */
function isPrivateIP(hostname: string): boolean {
  // Strip brackets from IPv6 addresses (e.g. [::1] -> ::1)
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  for (const prefix of PRIVATE_PREFIXES) {
    if (h.startsWith(prefix)) {
      return true;
    }
  }

  // Check 192.168.0.0/16
  if (h.startsWith("192.168.")) {
    return true;
  }

  // Check 172.16.0.0/12 range (172.16.x.x through 172.31.x.x)
  if (h.startsWith("172.")) {
    const second = parseInt(h.split(".")[1], 10);
    if (!isNaN(second) && second >= 16 && second <= 31) {
      return true;
    }
  }

  // Check 169.254.0.0/16 (link-local / cloud metadata)
  if (h.startsWith("169.254.")) {
    return true;
  }

  // Check decimal IPv4 (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(h)) {
    const num = Number(h);
    if (num >= 0 && num <= 0xffffffff) {
      const expanded = intToIPv4(num);
      return isPrivateIP(expanded);
    }
  }

  // Check hex IPv4 (e.g. 0x7f000001 = 127.0.0.1)
  if (/^0x[0-9a-fA-F]+$/.test(h)) {
    const num = parseInt(h, 16);
    if (num >= 0 && num <= 0xffffffff) {
      const expanded = intToIPv4(num);
      return isPrivateIP(expanded);
    }
  }

  // Check IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const v4MappedPrefix = "::ffff:";
  if (h.toLowerCase().startsWith(v4MappedPrefix)) {
    const suffix = h.slice(v4MappedPrefix.length);
    // Dotted-quad form: ::ffff:192.168.1.1
    if (suffix.includes(".")) {
      return isPrivateIP(suffix);
    }
    // Hex pair form: ::ffff:7f00:0001 -> parse as 32-bit int
    const hexParts = suffix.split(":");
    if (hexParts.length === 2) {
      const num = (parseInt(hexParts[0], 16) << 16) | parseInt(hexParts[1], 16);
      if (!isNaN(num)) {
        return isPrivateIP(intToIPv4(num >>> 0));
      }
    }
  }

  // Check IPv6 loopback (::1, [::1], ::, [::])
  if (h === "::1" || h === "::") {
    return true;
  }

  // Check IPv6 ULA (fc00::/7 — addresses starting with fc or fd)
  if (/^f[cd]/i.test(h)) {
    return true;
  }

  // Check IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(h)) {
    return true;
  }

  return false;
}

/**
 * Validate a browser URL for safety before sending to a container.
 *
 * @throws {Error} if the URL uses a blocked protocol, targets a metadata
 *   endpoint, loopback address, or private IP range.
 */
export function validateBrowserURL(rawURL: string): void {
  if (!rawURL) {
    throw new Error(`Invalid URL: empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawURL);
  } catch {
    throw new Error(`Invalid URL: ${rawURL}`);
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Blocked metadata endpoint: ${parsed.hostname}`);
  }

  if (parsed.hostname === "localhost" || isPrivateIP(parsed.hostname)) {
    throw new Error(`Blocked address: ${parsed.hostname}`);
  }
}
