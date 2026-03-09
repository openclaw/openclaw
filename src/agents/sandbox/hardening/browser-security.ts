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
 * Check if a hostname is a private or loopback IP address.
 */
function isPrivateIP(hostname: string): boolean {
  for (const prefix of PRIVATE_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }

  // Check 192.168.0.0/16
  if (hostname.startsWith("192.168.")) {
    return true;
  }

  // Check 172.16.0.0/12 range (172.16.x.x through 172.31.x.x)
  if (hostname.startsWith("172.")) {
    const second = parseInt(hostname.split(".")[1], 10);
    if (!isNaN(second) && second >= 16 && second <= 31) {
      return true;
    }
  }

  // Check 169.254.0.0/16 (link-local / cloud metadata)
  if (hostname.startsWith("169.254.")) {
    return true;
  }

  // Check IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") {
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
