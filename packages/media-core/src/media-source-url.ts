const REMOTE_MEDIA_URL_RE = /^(?:https?|mxc|buffer):\/\//i;

/** Decodes one URL filename layer, keeping encoded separators as filename data. */
export function fileNameFromMediaUrl(url: URL): string {
  const filename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(filename.replace(/%2f/gi, "%252F").replace(/%5c/gi, "%255C"));
  } catch {
    // Preserve the full raw filename for malformed percent encoding or UTF-8.
    return filename;
  }
}

/** Returns true for remote media URLs that should stay URL-backed instead of local-file-backed. */
export function isPassThroughRemoteMediaSource(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return REMOTE_MEDIA_URL_RE.test(normalized);
}
