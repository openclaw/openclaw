import {
  buildNodeJoinLink,
  bytesToBase64url,
  DEFAULT_NODE_INVITE_LIFETIME_SECONDS,
  deriveInviteProofKey,
  fingerprint,
  generateInviteSecret,
  inviteSecretHash,
  type PublicKeyText,
} from "@openclaw/openclaw-id-protocol";
import { buildNodeJoinCommands } from "./node-commands.js";
import { signAsOwner, signMembershipChange } from "./owner-signing.js";
import type { Link, NodeInvite, NodeRecord } from "./types.js";

type Request = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
export type CreatedNodeInvite = {
  inviteId: string;
  expiresAt: number;
  commands: ReturnType<typeof buildNodeJoinCommands>;
};

export async function createNodeInvite(
  request: Request,
  link: Link,
  label: string,
  relayUrl: string,
): Promise<CreatedNodeInvite> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + DEFAULT_NODE_INVITE_LIFETIME_SECONDS;
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  // Validate browser link inputs before registering an otherwise unusable invitation.
  // SAFETY: Gateway rootPub is a formatted public key; fingerprint validates its encoding.
  const rootFp = await fingerprint(link.rootPub as PublicKeyText);
  const joinLink = buildNodeJoinLink({
    invite_id,
    secret,
    claw_id: link.clawId ?? "",
    root_fp: rootFp,
    hostname: link.hostname ?? "",
    relay_url: relayUrl,
  });
  const cap = await signAsOwner(link, "NodeInviteCap", {
    claw_id: link.clawId ?? "",
    invite_id,
    label,
    created_at: now,
    expires_at: expiresAt,
    secret_hash: await inviteSecretHash(proofKey),
  });
  const metadata = await request<{ discoveryUrl: string | null; version: string }>(
    "openclawId.authority",
    { action: "register_node_invite", cap, proofKey: bytesToBase64url(proofKey) },
  );
  return {
    inviteId: invite_id,
    expiresAt,
    commands: buildNodeJoinCommands({ joinLink, ...metadata }),
  };
}

/** Only the exact request the owner reviewed can be approved; never auto-retry a write. */
export async function decideNodeInvite(
  request: Request,
  link: Link,
  shown: NodeInvite,
  approve: boolean,
) {
  const current = link.nodeInvites?.find((invite) => invite.inviteId === shown.inviteId);
  if (
    current?.status !== "pending" ||
    !current.pending ||
    current.pending.peerKey !== shown.pending?.peerKey ||
    current.pending.verificationCode !== shown.pending.verificationCode
  ) {
    throw new Error("This node request changed. Close it and review the current request.");
  }
  const statement = await signMembershipChange(
    link,
    approve
      ? {
          op: "add_node",
          peer_key: current.pending.peerKey,
          label: current.label,
          invite_id: current.inviteId,
        }
      : { op: "deny_invite", invite_id: current.inviteId },
  );
  await request("openclawId.authority", { action: "submit", statement });
  return true;
}

export async function removeNode(request: Request, link: Link, node: NodeRecord) {
  const statement = await signMembershipChange(link, { op: "remove_node", peer_key: node.peerKey });
  await request("openclawId.authority", { action: "submit", statement });
}
