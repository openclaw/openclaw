export type A2aPeerConfig = {
  name: string;
  url: string;
};

/** Resolve playbook ``target`` (URL or configured peer name) to an A2A base URL. */
export function resolveA2aTarget(target: string, peers: A2aPeerConfig[] = []): string {
  const trimmed = target.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, "");
  }
  const peer = peers.find((p) => p.name === trimmed);
  if (!peer) {
    throw new Error(
      `Unknown A2A peer "${trimmed}". Configure plugins.entries.claworks-robot.config.a2a.peers or use an http(s) URL.`,
    );
  }
  return peer.url.replace(/\/$/, "");
}

export function listA2aPeerNames(peers: A2aPeerConfig[] = []): string[] {
  return peers.map((p) => p.name);
}
