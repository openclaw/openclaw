// Signs owner statements with this browser's owner device key D. The Control
// UI's remote access setup (and the claw loader on a claw origin) stores D per claw
// in IndexedDB "openclaw-id" / "owner-devices" as a non-extractable key pair.
import {
  formatEd25519PublicKey,
  signStatement,
  type MembershipTarget,
  type SignedStatement,
  type StatementBodies,
  type StatementSigner,
  type StatementType,
} from "@openclaw/openclaw-id-protocol";
import type { Link, OwnerDevice } from "./types.js";

const DB_NAME = "openclaw-id";
const STORE = "owner-devices";

type StoredDeviceKey = { privateKey: CryptoKey; publicKey: CryptoKey };

/** Raised when this browser holds no owner device key for the claw. */
export class NoOwnerKeyError extends Error {
  readonly code = "no_owner_key";

  constructor() {
    super("This browser cannot manage access to this claw. Use an approved owner browser.");
  }
}

// Reads the stored key pair for a claw; resolves undefined when there is none.
function readDeviceKey(clawId: string): Promise<StoredDeviceKey | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.addEventListener("upgradeneeded", () => open.result.createObjectStore(STORE));
    open.addEventListener("error", () => reject(open.error ?? new Error("IndexedDB open failed")));
    open.addEventListener("success", () => {
      const db = open.result;
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(clawId);
      request.addEventListener("error", () => {
        db.close();
        reject(request.error ?? new Error("IndexedDB read failed"));
      });
      request.addEventListener("success", () => {
        db.close();
        // SAFETY: this object store holds only StoredDeviceKey records written by this module.
        resolve(request.result as StoredDeviceKey | undefined);
      });
    });
  });
}

/** This browser's owner device signer for a claw, if it holds one. */
async function loadOwnerDeviceSigner(clawId: string): Promise<StatementSigner | undefined> {
  const pair = await readDeviceKey(clawId);
  if (!pair) {
    return undefined;
  }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(message))),
  };
}

/** The listed owner device this browser signs as, or undefined. */
export async function thisOwnerDevice(link: Link): Promise<OwnerDevice | undefined> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  return link.ownerDevices?.find((device) => device.devicePub === devicePub);
}

/** Signs a statement as this browser's owner device; the Gateway checks it is still listed. */
export async function signAsOwner<T extends StatementType>(
  link: Link,
  type: T,
  body: StatementBodies[T],
): Promise<SignedStatement<T>> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  const own = link.ownerDevices?.find((device) => device.devicePub === devicePub);
  if (!signer || !own) {
    throw new NoOwnerKeyError();
  }
  return signStatement(type, body, signer);
}

/** Signs a MembershipChange at the Gateway's next seq. */
export function signMembershipChange(link: Link, target: MembershipTarget) {
  return signAsOwner(link, "MembershipChange", {
    claw_id: link.clawId ?? "",
    seq: (link.seq ?? 0) + 1,
    target,
    issued_at: Math.floor(Date.now() / 1000),
  });
}
