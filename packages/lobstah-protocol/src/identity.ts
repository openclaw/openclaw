import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";

export type Identity = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export const defaultIdentityPath = (): string =>
  process.env.LOBSTAH_IDENTITY ?? join(homedir(), ".lobstah", "identity.json");

export const generateIdentity = (): Identity => {
  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
};

export const sign = (message: Uint8Array, secretKey: Uint8Array): Uint8Array =>
  ed25519.sign(message, secretKey);

export const verify = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean => ed25519.verify(signature, message, publicKey);

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const formatPubkey = (pk: Uint8Array): string => `lob1${toHex(pk)}`;

export const parsePubkey = (s: string): Uint8Array => {
  if (!s.startsWith("lob1")) throw new Error(`bad pubkey (missing lob1 prefix): ${s}`);
  const hex = s.slice(4);
  if (hex.length !== 64) throw new Error(`bad pubkey (expected 64 hex chars, got ${hex.length})`);
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`bad pubkey (non-hex chars in body)`);
  return fromHex(hex);
};

type SerializedIdentity = {
  version: 1;
  publicKey: string;
  secretKey: string;
};

const serialize = (id: Identity): SerializedIdentity => ({
  version: 1,
  publicKey: formatPubkey(id.publicKey),
  secretKey: toHex(id.secretKey),
});

const deserialize = (s: SerializedIdentity): Identity => {
  if (s.version !== 1) throw new Error(`unsupported identity version: ${s.version}`);
  return {
    publicKey: parsePubkey(s.publicKey),
    secretKey: fromHex(s.secretKey),
  };
};

export const saveIdentity = async (
  id: Identity,
  path: string = defaultIdentityPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(serialize(id), null, 2));
  await chmod(path, 0o600);
};

export const loadIdentity = async (path: string = defaultIdentityPath()): Promise<Identity> => {
  const raw = await readFile(path, "utf8");
  return deserialize(JSON.parse(raw) as SerializedIdentity);
};

export const loadOrCreateIdentity = async (
  path: string = defaultIdentityPath(),
): Promise<{ identity: Identity; created: boolean }> => {
  if (existsSync(path)) {
    return { identity: await loadIdentity(path), created: false };
  }
  const identity = generateIdentity();
  await saveIdentity(identity, path);
  return { identity, created: true };
};
