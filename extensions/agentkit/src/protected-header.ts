import { Buffer } from "node:buffer";
import { formatSIWEMessage, type AgentkitPayload } from "./agentkit.runtime.js";
import type { AgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import { generatePrivateKey, privateKeyToAccount, type Hex } from "./viem.runtime.js";

export type AgentkitProtectedHeaderResult = {
  address: string;
  header: string;
  message: string;
  payload: AgentkitPayload;
  generatedPrivateKey: boolean;
};

function resolveEvmProtectedChallengeChain(challenge: AgentkitProtectedResourceChallenge) {
  const preferred = challenge.supportedChains.find(
    (chain) => chain.chainId.startsWith("eip155:") && chain.type === "eip191",
  );
  if (preferred) {
    return preferred;
  }
  const fallback = challenge.supportedChains.find((chain) => chain.chainId.startsWith("eip155:"));
  if (fallback) {
    return fallback;
  }
  throw new Error("Local signing currently supports EVM AgentKit challenges only.");
}

export async function buildAgentkitProtectedHeader(params: {
  challenge: AgentkitProtectedResourceChallenge;
  privateKey?: Hex;
}): Promise<AgentkitProtectedHeaderResult> {
  const chain = resolveEvmProtectedChallengeChain(params.challenge);
  const privateKey = params.privateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const message = formatSIWEMessage(
    {
      ...params.challenge.info,
      chainId: chain.chainId,
      type: chain.type,
    },
    account.address,
  );
  const signature = await account.signMessage({ message });
  const payload: AgentkitPayload = {
    ...params.challenge.info,
    address: account.address,
    chainId: chain.chainId,
    type: chain.type,
    signature,
  };

  return {
    address: account.address,
    header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    message,
    payload,
    generatedPrivateKey: params.privateKey == null,
  };
}
