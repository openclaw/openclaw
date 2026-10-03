// Tlon sender presentation keeps unverified club claims out of authority-bearing fields.
export function resolveTlonSenderPresentation(
  params: {
    senderShip: string;
    senderAuthenticated?: boolean;
    isGroup: boolean;
    channelNest?: string;
    clubId?: string;
  },
  senderIsOwner: boolean,
) {
  const senderAuthenticated = params.senderAuthenticated !== false;
  const groupId = params.channelNest ?? params.clubId;
  const senderRole = senderAuthenticated && senderIsOwner ? "owner" : "user";
  const fromLabel = params.clubId
    ? `${params.senderShip || "unknown"} [unverified] in club ${params.clubId}`
    : params.isGroup
      ? `${params.senderShip} [${senderRole}] in ${params.channelNest}`
      : `${params.senderShip} [${senderRole}]`;
  return {
    senderAuthenticated,
    groupId,
    senderRole,
    fromLabel,
    sender: {
      id: params.clubId ?? params.senderShip,
      name: params.clubId ? `${params.senderShip || "unknown"} (unverified)` : params.senderShip,
      roles: [senderRole],
    },
  };
}
