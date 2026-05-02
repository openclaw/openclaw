import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Peer = {
  pubkey: string;
  url: string;
  label?: string;
};

export const defaultPeersPath = (): string =>
  process.env.LOBSTAH_PEERS ?? join(homedir(), ".lobstah", "peers.json");

export const loadPeers = async (path: string = defaultPeersPath()): Promise<Peer[]> => {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`peers file is not an array: ${path}`);
  return parsed as Peer[];
};

export const savePeers = async (
  peers: Peer[],
  path: string = defaultPeersPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(peers, null, 2)}\n`);
};

export const addPeer = async (peer: Peer, path?: string): Promise<Peer[]> => {
  const peers = await loadPeers(path);
  const filtered = peers.filter((p) => p.pubkey !== peer.pubkey);
  filtered.push(peer);
  await savePeers(filtered, path);
  return filtered;
};

export const removePeer = async (pubkey: string, path?: string): Promise<Peer[]> => {
  const peers = await loadPeers(path);
  const filtered = peers.filter((p) => p.pubkey !== pubkey);
  await savePeers(filtered, path);
  return filtered;
};
