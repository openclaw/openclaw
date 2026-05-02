import { getCapacity, isHealthy } from "./peer-state.js";
import type { Peer } from "./peers.js";

let cursor = 0;

export const pickPeer = (peers: Peer[]): Peer | undefined => {
  if (peers.length === 0) return undefined;
  const peer = peers[cursor % peers.length];
  cursor += 1;
  return peer;
};

export const candidatesForModel = async (peers: Peer[], model: string): Promise<Peer[]> => {
  const out: Peer[] = [];
  for (const peer of peers) {
    if (!isHealthy(peer.pubkey)) continue;
    const cap = await getCapacity(peer);
    if (cap && cap.models.includes(model)) {
      out.push(peer);
    }
  }
  return out;
};

export const orderCandidates = (candidates: Peer[]): Peer[] => {
  if (candidates.length <= 1) return candidates;
  const offset = cursor % candidates.length;
  cursor += 1;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
};

export const resetCursor = (): void => {
  cursor = 0;
};
