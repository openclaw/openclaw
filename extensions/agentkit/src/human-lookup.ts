import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createAgentBookVerifier, type AgentBookVerifier } from "./agentkit.runtime.js";
import { createTrustVerifiedSignerAgentBookVerifier } from "./local-agentbook.js";

type AgentBookVerifierLike = Pick<AgentBookVerifier, "lookupHuman">;

export type AgentkitHumanLookupSelection = {
  agentBook: AgentBookVerifierLike;
  humanLookupMode: string;
};

function resolveOptionalAgentBookContractAddress(
  value: string | undefined,
): `0x${string}` | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(
      `Invalid AgentBook contract address: ${normalized}. Expected a 20-byte 0x-prefixed address.`,
    );
  }
  return normalized as `0x${string}`;
}

export function resolveAgentkitHumanLookup(params: {
  localTrustVerifiedSigner?: boolean;
  agentBookRpcUrl?: string;
  agentBookContractAddress?: string;
}): AgentkitHumanLookupSelection {
  if (params.localTrustVerifiedSigner === true) {
    return {
      agentBook: createTrustVerifiedSignerAgentBookVerifier(),
      humanLookupMode: "local-trust-verified-signer",
    };
  }

  const contractAddress = resolveOptionalAgentBookContractAddress(params.agentBookContractAddress);
  const rpcUrl = normalizeOptionalString(params.agentBookRpcUrl);
  return {
    agentBook: createAgentBookVerifier({
      ...(rpcUrl ? { rpcUrl } : {}),
      ...(contractAddress ? { contractAddress } : {}),
    }),
    humanLookupMode: "agentbook",
  };
}
