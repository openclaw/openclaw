import {
  formatAllowlistMatchMeta,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy,
} from "../../../runtime-api.js";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
} from "./allowlist.js";

type MatrixDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type MatrixGroupPolicy = "open" | "allowlist" | "disabled";

export async function resolveMatrixAccessState(params: {
  isDirectMessage: boolean;
  resolvedAccountId: string;
  dmPolicy: MatrixDmPolicy;
  groupPolicy: MatrixGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: Array<string | number>;
  senderId: string;
  readStoreForDmPolicy: (provider: string, accountId: string) => Promise<string[]>;
}) {
  const storeAllowFrom = params.isDirectMessage
    ? await readStoreAllowFromForDmPolicy({
        provider: "matrix",
        accountId: params.resolvedAccountId,
        dmPolicy: params.dmPolicy,
        readStore: params.readStoreForDmPolicy,
      })
    : [];
  const normalizedGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const senderGroupPolicy = resolveSenderScopedGroupPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: normalizedGroupAllowFrom,
  });
  const access = resolveDmGroupAccessWithLists({
    isGroup: !params.isDirectMessage,
    dmPolicy: params.dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: normalizedGroupAllowFrom,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      resolveMatrixAllowListMatches({
        allowList: normalizeMatrixAllowList(allowFrom),
        userId: params.senderId,
      }),
  });
  const effectiveAllowFrom = normalizeMatrixAllowList(access.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(access.effectiveGroupAllowFrom);
  return {
    access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    groupAllowConfigured: effectiveGroupAllowFrom.length > 0,
  };
}

export async function enforceMatrixDirectMessageAccess(params: {
  dmEnabled: boolean;
  dmPolicy: MatrixDmPolicy;
  accessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderName: string;
  effectiveAllowFrom: string[];
  issuePairingChallenge: (params: {
    senderId: string;
    senderIdLine: string;
    meta?: Record<string, string | undefined>;
    buildReplyText: (params: { code: string }) => string;
    sendPairingReply: (text: string) => Promise<void>;
    onCreated: () => void;
    onReplyError: (err: unknown) => void;
  }) => Promise<{ created: boolean; code?: string }>;
  sendPairingReply: (text: string) => Promise<void>;
  logVerboseMessage: (message: string) => void;
}): Promise<boolean> {
  if (!params.dmEnabled) {
    return false;
  }
  if (params.accessDecision === "allow") {
    return true;
  }
  const allowMatch = resolveMatrixAllowListMatch({
    allowList: params.effectiveAllowFrom,
    userId: params.senderId,
  });
  const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
  if (params.accessDecision === "pairing") {
    await params.issuePairingChallenge({
      senderId: params.senderId,
      senderIdLine: `Matrix user id: ${params.senderId}`,
      meta: { name: params.senderName },
      buildReplyText: ({ code }) =>
        [
          "OpenClaw: access not configured.",
          "",
          `Pairing code: ${code}`,
          "",
          "Ask the bot owner to approve with:",
          "openclaw pairing approve matrix <code>",
        ].join("\n"),
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.logVerboseMessage(
          `matrix pairing request sender=${params.senderId} name=${params.senderName ?? "unknown"} (${allowMatchMeta})`,
        );
      },
      onReplyError: (err) => {
        params.logVerboseMessage(
          `matrix pairing reply failed for ${params.senderId}: ${String(err)}`,
        );
      },
    });
    return false;
  }
  params.logVerboseMessage(
    `matrix: blocked dm sender ${params.senderId} (dmPolicy=${params.dmPolicy}, ${allowMatchMeta})`,
  );
  return false;
}
