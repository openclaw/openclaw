export function normalizeXReplyTarget(target: string): string | undefined {
  const normalized = target.trim();
  const id = /^(?:x:)?(\d+)$/i.exec(normalized)?.[1];
  if (id) {
    return id;
  }
  const url = URL.parse(normalized);
  return url?.protocol === "https:" && url.hostname === "x.com" && !url.username && !url.password
    ? /^\/[^/]+\/status\/(\d+)\/?$/.exec(url.pathname)?.[1]
    : undefined;
}
