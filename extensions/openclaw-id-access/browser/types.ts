// Response shapes of the Gateway's openclawId.* methods that the members page reads.
import type { IrohEndpointKey, MemberRole, NodeDescription } from "@openclaw/openclaw-id-protocol";

/** An active owner device as `openclawId.status` lists it. */
export type OwnerDevice = {
  devicePub: string;
  label: string;
  peerKeys: string[];
  cert: unknown;
  deviceFp?: string;
};

/** One active run a member's device started, read from the Gateway's run registry. */
type MemberRun = { runId: string; sessionKey: string };

/** One of a member's device keys with its live activity on this Gateway. */
export type MemberDevice = {
  peerKey: string;
  /** Open relayed Gateway connections for this key. */
  connections: number;
  /** Last activity this Gateway saw, ms since the epoch; null when not seen since it started. */
  lastSeenAt: number | null;
  runs: MemberRun[];
};

/** One member of the claw. Name and email are reported by OpenClaw ID; display only. */
export type Member = {
  accountId: string;
  role: string;
  peerKeys: string[];
  email?: string | null;
  displayName?: string | null;
  /** When the owner approved them, seconds since the epoch. */
  approvedAt?: number | null;
  devices?: MemberDevice[];
};

/** What an accepted removal cut (`openclawId.authority` submit result `removal`). */
export type RemovalSummary = { devices: number; connectionsClosed: number; runsCancelled: number };

/** One invite as the Gateway lists it to owners. */
export type Invite = {
  inviteId: string;
  label: string;
  role: MemberRole;
  audience: { kind: "account_id" | "email"; value: string };
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  pending?: {
    accountId: string;
    devicePub: string;
    peerKey: string;
    requestedAt: number;
    decideBy: number;
    /** Reported by OpenClaw ID; display only. */
    reported: { email: string | null; displayName: string | null; locationHint: string | null };
  };
};

/**
 * The claw's link state: `openclawId.status` returns only linked, clawId, hostname and
 * rootPub; `openclawId.people` (owner only) returns all of it.
 */
export type Link = {
  linked: boolean;
  clawId?: string;
  hostname?: string;
  rootPub?: string;
  seq?: number;
  ownerDevices?: OwnerDevice[];
  members?: Member[];
  invites?: Invite[];
  nodes?: NodeRecord[];
  nodeInvites?: NodeInvite[];
  publication?:
    | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
    | { state: "needs_enrollment_code" }
    | { state: "failed"; code: string; message: string };
};

/** The `openclawId.status` result. */
export type StatusResult = {
  status: {
    state: "off" | "unconfigured" | "on" | "failed";
    tunnel?: { state: string; relayUrl?: string };
  };
  link: Link;
  channel: "local_operator" | "tunnel" | null;
  /** Whether `openclawId.people` answers this client (loopback operator or an owner device). */
  owner?: boolean;
};

/** Owner-only public node projection; never contains the invitation proof key. */
export type NodeRecord = {
  peerKey: IrohEndpointKey;
  label: string;
  description: NodeDescription;
  addedBy: string;
  lastSeen: number;
  inviteId: string;
};
export type NodeInvite = {
  inviteId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  pending?: {
    peerKey: IrohEndpointKey;
    requestedAt: number;
    decideBy: number;
    description: NodeDescription;
    verificationCode: string;
  };
};
