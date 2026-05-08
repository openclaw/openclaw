import { randomBytes } from "node:crypto";
import {
  buildAgentkitSchema,
  type SignatureType,
  type SupportedChain,
} from "./agentkit.runtime.js";

export const DEFAULT_AGENTKIT_VERIFIER_NETWORK = "eip155:480";
export const DEFAULT_AGENTKIT_VERIFIER_RESOURCE_PATH = "/protected";
export const DEFAULT_AGENTKIT_VERIFIER_STATEMENT =
  "Sign in to access the OpenClaw AgentKit protected resource.";
export const DEFAULT_AGENTKIT_VERIFIER_VERSION = "1";
export const DEFAULT_AGENTKIT_VERIFIER_EXPIRATION_SECONDS = 300;

export type AgentkitProtectedResourceChallenge = {
  info: {
    domain: string;
    uri: string;
    statement?: string;
    version: string;
    nonce: string;
    issuedAt: string;
    expirationTime?: string;
    resources?: string[];
  };
  supportedChains: SupportedChain[];
  schema: ReturnType<typeof buildAgentkitSchema>;
};

function resolveSupportedSignatureTypes(network: string): SignatureType[] {
  return network.startsWith("solana:") ? ["ed25519"] : ["eip191", "eip1271"];
}

export function createAgentkitProtectedResourceChallenge(params: {
  resourceUrl: string;
  network?: string;
  statement?: string;
  expirationSeconds?: number;
  now?: Date;
}): AgentkitProtectedResourceChallenge {
  const resourceUrl = new URL(params.resourceUrl).toString();
  const network = params.network ?? DEFAULT_AGENTKIT_VERIFIER_NETWORK;
  const resource = new URL(resourceUrl);
  const issuedAt = (params.now ?? new Date()).toISOString();
  const expirationSeconds =
    params.expirationSeconds ?? DEFAULT_AGENTKIT_VERIFIER_EXPIRATION_SECONDS;
  const expirationTime =
    expirationSeconds > 0
      ? new Date(Date.parse(issuedAt) + expirationSeconds * 1_000).toISOString()
      : undefined;

  return {
    info: {
      domain: resource.hostname,
      uri: resourceUrl,
      statement: params.statement ?? DEFAULT_AGENTKIT_VERIFIER_STATEMENT,
      version: DEFAULT_AGENTKIT_VERIFIER_VERSION,
      nonce: randomBytes(16).toString("hex"),
      issuedAt,
      expirationTime,
      resources: [resourceUrl],
    },
    supportedChains: resolveSupportedSignatureTypes(network).map((type) => ({
      chainId: network,
      type,
    })),
    schema: buildAgentkitSchema(),
  };
}
