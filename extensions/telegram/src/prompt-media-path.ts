import path from "node:path";

export function resolveTelegramInboundMediaUri(id: string): string | undefined {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    return undefined;
  }
  return `media://inbound/${encodeURIComponent(id)}`;
}

export function resolveTelegramPromptMediaPath(mediaPath: string): string | undefined {
  const canonicalMatch = /^media:\/\/inbound\/([^/\\]+)$/i.exec(mediaPath);
  if (canonicalMatch?.[1]) {
    try {
      return resolveTelegramInboundMediaUri(decodeURIComponent(canonicalMatch[1]));
    } catch {
      return undefined;
    }
  }
  const normalized = mediaPath.replace(/\\/g, "/");
  if (!normalized.includes("/media/inbound/")) {
    return undefined;
  }
  return resolveTelegramInboundMediaUri(path.posix.basename(normalized));
}
