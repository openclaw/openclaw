import type { A2aPeerConfig } from "./a2a-peers.js";
import type { RbacCheckInput } from "./robot-identity.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type ResolvedA2aPeer = {
  peerId: string;
  subjectType: "peer";
  subjectId: string;
};

/** 从 metadata / source 解析对等机器人 ID。 */
export function resolveA2aPeerId(meta: Record<string, unknown>): string | null {
  if (typeof meta.peer_id === "string" && meta.peer_id.trim()) {
    return meta.peer_id.trim();
  }
  if (typeof meta.peer === "string" && meta.peer.trim()) {
    return meta.peer.trim();
  }
  const source = typeof meta.source === "string" ? meta.source : "";
  const match = source.match(/^a2a:\/\/([^/?#]+)/i);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

export function resolveA2aPeer(
  meta: Record<string, unknown>,
  configuredPeers: A2aPeerConfig[],
): ResolvedA2aPeer | { error: string } {
  const peerId = resolveA2aPeerId(meta);
  if (!peerId) {
    return { error: "missing peer_id (metadata.peer_id or a2a://<peer>/ source)" };
  }

  if (configuredPeers.length > 0 && !configuredPeers.some((p) => p.name === peerId)) {
    return { error: `unknown A2A peer "${peerId}"` };
  }

  return { peerId, subjectType: "peer", subjectId: peerId };
}

export function checkA2aPeerRbac(
  runtime: ClaworksRuntime,
  peer: ResolvedA2aPeer,
  action: "a2a.delegate" | "event.publish",
  resource: string,
): { allowed: true } | { allowed: false; reason: string } {
  const input: RbacCheckInput = {
    action,
    resource,
    subjectType: peer.subjectType,
    subjectId: peer.subjectId,
  };
  return runtime.rbac.check(input);
}
