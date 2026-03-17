import {
  formatAllowlistMatchMeta,
  issuePairingChallenge,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy
} from "openclaw/plugin-sdk/matrix";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches
} from "./allowlist.js";
async function resolveMatrixAccessState(params) {
  const storeAllowFrom = params.isDirectMessage ? await readStoreAllowFromForDmPolicy({
    provider: "matrix",
    accountId: params.resolvedAccountId,
    dmPolicy: params.dmPolicy,
    readStore: params.readStoreForDmPolicy
  }) : [];
  const normalizedGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const senderGroupPolicy = resolveSenderScopedGroupPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: normalizedGroupAllowFrom
  });
  const access = resolveDmGroupAccessWithLists({
    isGroup: !params.isDirectMessage,
    dmPolicy: params.dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: normalizedGroupAllowFrom,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) => resolveMatrixAllowListMatches({
      allowList: normalizeMatrixAllowList(allowFrom),
      userId: params.senderId
    })
  });
  const effectiveAllowFrom = normalizeMatrixAllowList(access.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(access.effectiveGroupAllowFrom);
  return {
    access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    groupAllowConfigured: effectiveGroupAllowFrom.length > 0
  };
}
async function enforceMatrixDirectMessageAccess(params) {
  if (!params.dmEnabled) {
    return false;
  }
  if (params.accessDecision === "allow") {
    return true;
  }
  const allowMatch = resolveMatrixAllowListMatch({
    allowList: params.effectiveAllowFrom,
    userId: params.senderId
  });
  const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
  if (params.accessDecision === "pairing") {
    await issuePairingChallenge({
      channel: "matrix",
      senderId: params.senderId,
      senderIdLine: `Matrix user id: ${params.senderId}`,
      meta: { name: params.senderName },
      upsertPairingRequest: params.upsertPairingRequest,
      buildReplyText: ({ code }) => [
        "OpenClaw: access not configured.",
        "",
        `Pairing code: ${code}`,
        "",
        "Ask the bot owner to approve with:",
        "openclaw pairing approve matrix <code>"
      ].join("\n"),
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.logVerboseMessage(
          `matrix pairing request sender=${params.senderId} name=${params.senderName ?? "unknown"} (${allowMatchMeta})`
        );
      },
      onReplyError: (err) => {
        params.logVerboseMessage(
          `matrix pairing reply failed for ${params.senderId}: ${String(err)}`
        );
      }
    });
    return false;
  }
  params.logVerboseMessage(
    `matrix: blocked dm sender ${params.senderId} (dmPolicy=${params.dmPolicy}, ${allowMatchMeta})`
  );
  return false;
}
export {
  enforceMatrixDirectMessageAccess,
  resolveMatrixAccessState
};
