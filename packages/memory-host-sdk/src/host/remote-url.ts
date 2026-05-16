export function normalizeRemoteBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const parsed = new URL(trimmed);
  if (parsed.search || parsed.hash) {
    throw new Error("Remote base URL must not include a query string or fragment");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function joinRemoteEndpoint(baseUrl: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Remote endpoint path must start with '/'");
  }
  return `${normalizeRemoteBaseUrl(baseUrl)}${path}`;
}
