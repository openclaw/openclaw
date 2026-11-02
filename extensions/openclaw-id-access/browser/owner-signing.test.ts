import {
  certificateChain,
  formatEd25519PublicKey,
  generateEd25519Signer,
  signStatement,
  type SignedStatement,
  type StatementSigner,
} from "@openclaw/openclaw-id-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signAsOwner } from "./owner-signing.js";
import type { Link } from "./types.js";

const stored = new Map<string, CryptoKeyPair>();

// A minimal IndexedDB stand-in: opening succeeds and `get` answers from `stored`.
function fakeIndexedDb() {
  const request = <T>(result: () => T) => {
    const target = new EventTarget() as EventTarget & { result?: T; error: null };
    queueMicrotask(() => {
      target.result = result();
      target.dispatchEvent(new Event("success"));
    });
    return target;
  };
  const db = {
    close: () => {},
    transaction: () => ({
      objectStore: () => ({ get: (key: string) => request(() => stored.get(key)) }),
    }),
  };
  return { open: () => request(() => db) };
}

afterEach(() => {
  stored.clear();
  vi.unstubAllGlobals();
});

// Stores a fresh owner device key for `clawId` the way the Control UI does, returning its signer.
async function storeDeviceKey(clawId: string): Promise<StatementSigner> {
  vi.stubGlobal("indexedDB", fakeIndexedDb());
  const pair = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  stored.set(clawId, pair);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(message))),
  };
}

// An owner device certificate for `device`, issued by `issuer` with the issuer's chain.
function cert(
  device: StatementSigner,
  issuer: StatementSigner,
  chain: SignedStatement<"OwnerDeviceCert">[],
): Promise<SignedStatement<"OwnerDeviceCert">> {
  return signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [],
      label: "test",
      caps: ["owner"],
      root_epoch: 1,
      issued_at: 1,
    } as never,
    issuer,
    chain,
  );
}

describe("signAsOwner", () => {
  it("passes a flat chain for a device approved by another owner device", async () => {
    const root = await generateEd25519Signer();
    const first = await generateEd25519Signer();
    const second = await storeDeviceKey("claw");
    const firstCert = await cert(first, root, []);
    const secondCert = await cert(second, first, certificateChain(firstCert));
    const link = {
      clawId: "claw",
      ownerDevices: [{ devicePub: formatEd25519PublicKey(second.publicKey), cert: secondCert }],
    } as unknown as Link;

    const statement = await signAsOwner(link, "Revocation", {
      target_fp: "fp",
      target_kind: "member",
      reason: "test",
      root_epoch: 1,
      issued_at: 1,
    } as never);

    expect(statement.chain.map((entry) => entry.signer)).toEqual([
      formatEd25519PublicKey(first.publicKey),
      formatEd25519PublicKey(root.publicKey),
    ]);
    expect(statement.chain.every((entry) => entry.chain.length === 0)).toBe(true);
  });
});
