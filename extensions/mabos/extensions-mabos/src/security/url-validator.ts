interface UrlValidatorConfig {
  blockedCidrs?: string[];
  allowedDomains?: string[];
}

const PRIVATE_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata.google"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class UrlValidator {
  private allowedDomains: Set<string>;

  constructor(config?: UrlValidatorConfig) {
    this.allowedDomains = new Set(config?.allowedDomains ?? []);
  }

  isSafe(urlString: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      return false;
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (this.allowedDomains.has(hostname)) return true;
    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    for (const pattern of PRIVATE_PATTERNS) {
      if (pattern.test(hostname)) return false;
    }
    return true;
  }
}
