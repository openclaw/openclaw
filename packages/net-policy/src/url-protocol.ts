const HTTP_URL_PREFIX_RE = /^https?:\/\//i;

function parseUrl(value: string | URL): URL | null {
  return value instanceof URL ? value : URL.parse(value);
}

export function hasHttpUrlPrefix(value: string): boolean {
  return HTTP_URL_PREFIX_RE.test(value);
}

export function isHttpUrl(value: string | URL): boolean {
  const url = parseUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}

export function isHttpsUrl(value: string | URL): boolean {
  return parseUrl(value)?.protocol === "https:";
}

export function isWebSocketUrl(value: string | URL): boolean {
  const url = parseUrl(value);
  return url?.protocol === "ws:" || url?.protocol === "wss:";
}

export function isWssUrl(value: string | URL): boolean {
  return parseUrl(value)?.protocol === "wss:";
}
