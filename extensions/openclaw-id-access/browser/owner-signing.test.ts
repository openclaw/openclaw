import {
  formatEd25519PublicKey,
  generateEd25519Signer,
  hasValidSignature,
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

// An owner device certificate for `device`, issued by `issuer`.
function cert(
  device: StatementSigner,
  issuer: StatementSigner,
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
  );
}

describe("signAsOwner", () => {
  it("signs as this browser's listed device, with no certificate chain", async () => {
    const first = await generateEd25519Signer();
    const second = await storeDeviceKey("claw");
    const secondCert = await cert(second, first);
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

    expect(statement.signer).toBe(formatEd25519PublicKey(second.publicKey));
    expect(statement).not.toHaveProperty("chain");
    await expect(hasValidSignature(statement)).resolves.toBe(true);
  });
});

it("signs set_role with the listed browser key and rejects undefined roles before submission", async () => {
  const { changeMemberRole, createInvite } = await import("./invites.js");
  const { parseStatement } = await import("@openclaw/openclaw-id-protocol");
  const clawId = "c".repeat(32);
  const signer = await storeDeviceKey(clawId);
  const link: Link = {
    linked: true,
    clawId,
    seq: 7,
    ownerDevices: [
      {
        devicePub: formatEd25519PublicKey(signer.publicKey),
        label: "Browser",
        peerKeys: [],
        cert: {},
      },
    ],
    roles: [
      { name: "viewer", defined: true, sessions: "view", requiresSandbox: false, admin: false },
    ],
  };
  const request = vi.fn();
  await changeMemberRole(request, link, "member", "viewer", false);
  const params = request.mock.calls[0]?.[1];
  expect(request.mock.calls[0]?.[0]).toBe("openclawId.authority");
  expect(params.action).toBe("submit");
  const parsed = parseStatement(params.statement, "MembershipChange");
  if (!parsed.ok) {
    throw new Error(parsed.detail);
  }
  expect(parsed.statement.body).toMatchObject({
    seq: 8,
    target: { op: "set_role", account_id: "member", role: "viewer" },
  });
  expect(parsed.statement.signer).toBe(formatEd25519PublicKey(signer.publicKey));
  await expect(hasValidSignature(parsed.statement)).resolves.toBe(true);
  request.mockClear();
  await expect(changeMemberRole(request, link, "member", "deleted", false)).rejects.toMatchObject({
    code: "role_undefined",
  });
  await expect(
    createInvite(request, link, "person@example.test", "deleted", false),
  ).rejects.toMatchObject({ code: "role_undefined" });
  expect(request).not.toHaveBeenCalled();
  await expect(
    changeMemberRole(
      request,
      {
        ...link,
        roles: [
          {
            name: "Research Team",
            defined: true,
            sessions: "view",
            requiresSandbox: false,
            admin: false,
          },
        ],
      },
      "member",
      "Research Team",
      false,
    ),
  ).rejects.toMatchObject({ code: "role_invalid" });
  expect(request).not.toHaveBeenCalled();
  stored.clear();
  await expect(changeMemberRole(request, link, "member", "viewer", false)).rejects.toMatchObject({
    code: "no_owner_key",
  });
  expect(request).not.toHaveBeenCalled();
});
