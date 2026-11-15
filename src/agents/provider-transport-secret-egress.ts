import { containsSecretSentinel, swapSecretSentinelsInText } from "../secrets/sentinel.js";

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

export function swapSecretSentinelsForEgress(params: { url: string; headers?: HeadersInit }): {
  url: string;
  headers?: Headers;
} {
  if (!containsSecretSentinel(params.url) && !headersContainSecretSentinel(params.headers)) {
    return { url: params.url };
  }
  // Sentinels are URL-safe placeholders. Encode the real bytes so query/path structure is stable.
  const urlSwap = swapSecretSentinelsInText(params.url, encodeURIComponent);
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
