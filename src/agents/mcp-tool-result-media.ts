/**
 * Tracks MCP binary content that OpenClaw itself staged for outbound delivery.
 *
 * MCP servers are external and must not be able to bless arbitrary local paths
 * as trusted channel attachments. The registry is intentionally process-local:
 * it only authorizes paths produced by the current host while handling a tool
 * result, which is the window where channel relay consumes them.
 */

const MAX_HOST_OWNED_MCP_MEDIA_PATHS = 2_000;
const hostOwnedMcpMediaPaths: string[] = [];
const hostOwnedMcpMediaPathSet = new Set<string>();

export function registerHostOwnedMcpMediaPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed || hostOwnedMcpMediaPathSet.has(trimmed)) {
    return;
  }
  hostOwnedMcpMediaPaths.push(trimmed);
  hostOwnedMcpMediaPathSet.add(trimmed);
  while (hostOwnedMcpMediaPaths.length > MAX_HOST_OWNED_MCP_MEDIA_PATHS) {
    const oldest = hostOwnedMcpMediaPaths.shift();
    if (oldest) {
      hostOwnedMcpMediaPathSet.delete(oldest);
    }
  }
}

export function isHostOwnedMcpMediaPath(path: string): boolean {
  return hostOwnedMcpMediaPathSet.has(path.trim());
}

export function clearHostOwnedMcpMediaPathsForTest(): void {
  hostOwnedMcpMediaPaths.length = 0;
  hostOwnedMcpMediaPathSet.clear();
}
