function normalizeGatewayScope(gatewayUrl: string, includeSearch: boolean): string {
  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    return "default";
  }
  const browserLocation = (
    globalThis as {
      location?: { protocol: string; host: string; pathname: string };
    }
  ).location;
  const base = browserLocation
    ? `${browserLocation.protocol}//${browserLocation.host}${browserLocation.pathname || "/"}`
    : undefined;
  const parsed = URL.parse(trimmed, base);
  if (!parsed) {
    return trimmed;
  }
  const pathname =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${pathname}${includeSearch ? parsed.search : ""}`;
}

/** Normalizes the gateway URL scope used for origin-bound device tokens. */
export function gatewayOriginScope(gatewayUrl: string): string {
  return normalizeGatewayScope(gatewayUrl, false);
}

/** Normalizes the gateway URL scope used for browser credential records. */
export function gatewayCredentialScope(gatewayUrl: string): string {
  return normalizeGatewayScope(gatewayUrl, true);
}
