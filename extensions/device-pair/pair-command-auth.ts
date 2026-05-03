type PairingCommandAuthParams = {
  channel: string;
  gatewayClientScopes?: readonly string[] | null;
};

type PairingCommandAuthState = {
  isInternalGatewayCaller: boolean;
  isMissingPairingPrivilege: boolean;
  approvalCallerScopes?: readonly string[];
};

function isInternalGatewayPairingCaller(params: PairingCommandAuthParams): boolean {
  return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}

export function resolvePairingCommandAuthState(
  params: PairingCommandAuthParams,
): PairingCommandAuthState {
  const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
  if (!isInternalGatewayCaller) {
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: true,
      approvalCallerScopes: undefined,
    };
  }

  const approvalCallerScopes = Array.isArray(params.gatewayClientScopes)
    ? params.gatewayClientScopes
    : [];
  const isMissingPairingPrivilege =
    !approvalCallerScopes.includes("operator.pairing") &&
    !approvalCallerScopes.includes("operator.admin");

  return {
    isInternalGatewayCaller,
    isMissingPairingPrivilege,
    approvalCallerScopes,
  };
}

export function buildMissingPairingScopeReply(): { text: string } {
  return {
    text: "⚠️ This command requires operator.pairing.",
  };
}
