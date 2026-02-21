const threadRoots = new Map<string, string>();

export function setThreadRoot(channelId: string, rootId: string) {
  threadRoots.set(channelId, rootId);
}

export function getThreadRoot(channelId: string): string | undefined {
  return threadRoots.get(channelId);
}
