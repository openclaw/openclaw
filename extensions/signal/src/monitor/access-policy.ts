import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { isSignalSenderAllowed, type SignalSender } from "../identity.js";

type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";

export async function resolveSignalAccessState(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  sender: SignalSender;
  /**
   * Signal group id (base64). When the access decision is being made for a
   * group message, the configured `groupAllowFrom` list should be matched
   * against the group id directly, not against the sender's phone/UUID —
   * `groupAllowFrom` is documented as a list of group ids, but
   * `isSignalSenderAllowed` parses each entry as a phone/UUID identity and
   * always returned `false` when the list contained only base64 group ids.
   * Passing `groupId` through here lets the access callback honor both
   * shapes (#53308).
   */
  groupId?: string;
}) {
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "signal",
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
  });
  // Allow either a sender-identity match (legacy behavior, still valid for
  // DM allowFrom and for any operator whose groupAllowFrom mixes phone/UUIDs
  // and group ids) or a direct group-id match against the entries.
  const isSenderOrGroupAllowed = (allowEntries: string[]) => {
    if (isSignalSenderAllowed(params.sender, allowEntries)) {
      return true;
    }
    if (params.groupId && allowEntries.includes(params.groupId)) {
      return true;
    }
    return false;
  };
  const resolveAccessDecision = (isGroup: boolean) =>
    resolveDmGroupAccessWithLists({
      isGroup,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: params.groupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: isSenderOrGroupAllowed,
    });
  const dmAccess = resolveAccessDecision(false);
  return {
    resolveAccessDecision,
    dmAccess,
    effectiveDmAllow: dmAccess.effectiveAllowFrom,
    effectiveGroupAllow: dmAccess.effectiveGroupAllowFrom,
  };
}

export async function handleSignalDirectMessageAccess(params: {
  dmPolicy: SignalDmPolicy;
  dmAccessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderIdLine: string;
  senderDisplay: string;
  senderName?: string;
  accountId: string;
  sendPairingReply: (text: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<boolean> {
  if (params.dmAccessDecision === "allow") {
    return true;
  }
  if (params.dmAccessDecision === "block") {
    if (params.dmPolicy !== "disabled") {
      params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
    }
    return false;
  }
  if (params.dmPolicy === "pairing") {
    await createChannelPairingChallengeIssuer({
      channel: "signal",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          channel: "signal",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.senderId,
      senderIdLine: params.senderIdLine,
      meta: { name: params.senderName },
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.log(`signal pairing request sender=${params.senderId}`);
      },
      onReplyError: (err) => {
        params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
    });
  }
  return false;
}
