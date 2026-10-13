import {
  containsSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_PATTERN,
  swapSecretSentinelsInText,
} from "../secrets/sentinel.js";

function headersContainSecretSentinel(headers: HeadersInit | undefined): boolean {
  if (!headers) {
    return false;
  }
  // Read SDK-prepared headers directly; custom iterators still need HeadersInit conversion.
  const normalized =
    headers instanceof Headers && headers[Symbol.iterator] === Headers.prototype.entries
      ? headers
      : new Headers(headers);
  for (const value of Headers.prototype.values.call(normalized)) {
    if (containsSecretSentinel(value)) {
      return true;
    }
  }
  return false;
}

function swapSecretSentinelsInUrl(url: string): { text: string; unknown: string[] } {
  if (!containsSecretSentinel(url)) {
    return { text: url, unknown: [] };
  }
  const unknown = new Set<string>();
  const text = url.replace(new RegExp(SECRET_SENTINEL_PATTERN.source, "g"), (sentinel) => {
    const value = resolveSecretSentinel(sentinel);
    if (value === undefined) {
      unknown.add(sentinel);
      return sentinel;
    }
    // Sentinels are URL-safe placeholders. Encode the real bytes so query/path structure is stable.
    return encodeURIComponent(value);
  });
  return { text, unknown: [...unknown] };
}

export function swapSecretSentinelsForEgress(params: { url: string; headers?: HeadersInit }): {
  url: string;
  headers?: Headers;
} {
  if (!containsSecretSentinel(params.url) && !headersContainSecretSentinel(params.headers)) {
    return { url: params.url };
  }
  const urlSwap = swapSecretSentinelsInUrl(params.url);
  const headers = params.headers ? new Headers(params.headers) : undefined;
  const unknown = new Set(urlSwap.unknown);
  if (headers) {
    for (const [name, value] of headers.entries()) {
      const swapped = swapSecretSentinelsInText(value);
      headers.set(name, swapped.text);
      for (const sentinel of swapped.unknown) {
        unknown.add(sentinel);
      }
    }
  }
  const unresolved = unknown.values().next().value;
  if (unresolved) {
    throw new Error(
      `Secret sentinel ${unresolved} is not registered in this process; refusing to send request`,
    );
  }
  return { url: urlSwap.text, ...(headers ? { headers } : {}) };
}
