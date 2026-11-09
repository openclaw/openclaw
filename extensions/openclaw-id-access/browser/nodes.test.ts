import {
  base64urlToBytes,
  deriveInviteProofKey,
  formatEd25519PublicKey,
  hasValidSignature,
  inviteSecretHash,
  parseNodeJoinLink,
} from "@openclaw/openclaw-id-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNodeInvite, decideNodeInvite, removeNode } from "./nodes.js";
import type { Link, NodeInvite } from "./types.js";

// Only IndexedDB and the Gateway RPC are fixtures; owner signing remains real.
async function installOwnerKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const eventRequest = (result: unknown) => {
    const target = Object.assign(new EventTarget(), { result });
    queueMicrotask(() => target.dispatchEvent(new Event("success")));
    return target;
  };
  const db = {
    close() {},
    transaction: () => ({ objectStore: () => ({ get: () => eventRequest(pair) }) }),
  };
  vi.stubGlobal("indexedDB", { open: () => eventRequest(db) });
  const pub = formatEd25519PublicKey(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  link.ownerDevices = [{ devicePub: pub, label: "Owner browser", peerKeys: [], cert: {} }];
}
const invite: NodeInvite = {
  inviteId: "11".repeat(16),
  label: "Build machine",
  createdAt: 1,
  expiresAt: 600,
  status: "pending",
  pending: {
    peerKey: `iroh:${"22".repeat(32)}`,
    requestedAt: 2,
    decideBy: 604802,
    verificationCode: "004219",
    description: { display_name: "Builder", platform: "linux", commands: ["system.run"], caps: [] },
  },
};
const link: Link = {
  linked: true,
  clawId: "33".repeat(16),
  hostname: "claw.example.test",
  rootPub: `ed25519:${"44".repeat(32)}`,
  seq: 7,
  nodeInvites: [invite],
};
beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  await installOwnerKey();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("registers only a signed cap and proof key; builds the secret-bearing command locally", async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ discoveryUrl: "https://discovery.example.test", version: "2026.11.5" });
  const made = await createNodeInvite(request, link, "Builder", "https://relay.example.test");
  const [method, params] = request.mock.calls[0]!;
  expect(method).toBe("openclawId.authority");
  expect(Object.keys(params).toSorted()).toEqual(["action", "cap", "proofKey"]);
  expect(params.action).toBe("register_node_invite");
  expect(params.cap.type).toBe("NodeInviteCap");
  expect(params.cap.body.expires_at - params.cap.body.created_at).toBe(600);
  expect(params.cap.body.label).toBe("Builder");
  expect(await hasValidSignature(params.cap)).toBe(true);
  const joinLink = made.commands!.installedCommand.split("'")[1]!;
  const decoded = parseNodeJoinLink(joinLink)!;
  expect(decoded.invite_id).toBe(made.inviteId);
  expect(decoded.claw_id).toBe(link.clawId);
  expect(await deriveInviteProofKey(decoded.secret)).toEqual(base64urlToBytes(params.proofKey));
  expect(await inviteSecretHash(base64urlToBytes(params.proofKey))).toBe(
    params.cap.body.secret_hash,
  );
  expect(JSON.stringify(request.mock.calls)).not.toContain(joinLink);
  request.mockResolvedValue({ discoveryUrl: null, version: "2026.11.5" });
  expect(
    (await createNodeInvite(request, link, "Builder", "https://relay.example.test")).commands,
  ).toBeNull();
});

it("signs explicit approve, deny and remove at the freshly read membership sequence", async () => {
  const request = vi.fn().mockResolvedValue({});
  await decideNodeInvite(request, link, invite, true);
  await decideNodeInvite(request, link, invite, false);
  await removeNode(request, link, {
    peerKey: invite.pending!.peerKey,
    label: invite.label,
    description: invite.pending!.description,
    addedBy: "root",
    lastSeen: 1,
    inviteId: invite.inviteId,
  });
  expect(request.mock.calls.map(([, params]) => params.statement.body)).toEqual([
    {
      claw_id: link.clawId,
      seq: 8,
      issued_at: 1,
      target: {
        op: "add_node",
        peer_key: invite.pending!.peerKey,
        label: invite.label,
        invite_id: invite.inviteId,
      },
    },
    {
      claw_id: link.clawId,
      seq: 8,
      issued_at: 1,
      target: { op: "deny_invite", invite_id: invite.inviteId },
    },
    {
      claw_id: link.clawId,
      seq: 8,
      issued_at: 1,
      target: { op: "remove_node", peer_key: invite.pending!.peerKey },
    },
  ]);
  for (const [, params] of request.mock.calls) {
    expect(await hasValidSignature(params.statement)).toBe(true);
  }
  await expect(
    decideNodeInvite(request, { ...link, nodeInvites: [] }, invite, true),
  ).rejects.toThrow("changed");
  expect(request).toHaveBeenCalledTimes(3);
});
