const REMOTE_MEDIA_URL_RE = /^(?:https?|mxc|buffer):\/\//i;

/** Returns true for remote media URLs that should stay URL-backed instead of local-file-backed. */
export function isPassThroughRemoteMediaSource(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return REMOTE_MEDIA_URL_RE.test(normalized);
}
