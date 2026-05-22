export type A2aPeerConfig = {
  name: string;
  /** 对端基础 URL（url 的别名，两者等价） */
  url: string;
  /** 对端端点（与 url 等价，供旧代码使用 .endpoint 的地方） */
  endpoint?: string;
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
