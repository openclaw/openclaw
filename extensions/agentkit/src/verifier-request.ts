import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AGENTKIT } from "./agentkit.runtime.js";
import {
  requestAgentkitProtectedResource,
  formatAgentkitProtectedRequestResult,
} from "./protected-request.js";
import { type Hex } from "./viem.runtime.js";

type FetchImpl = typeof fetch;

export type AgentkitVerifierRequestResult = {
  serverOrigin: string;
  protectedResourceUrl: string;
  signerAddress: string;
  generatedPrivateKey: boolean;
  challengeStatus: number;
  finalStatus: number;
  responseBody: unknown;
};

export async function runAgentkitVerifierRequest(params: {
  serverOrigin: string;
  privateKey?: string;
  fetchImpl?: FetchImpl;
}): Promise<AgentkitVerifierRequestResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const serverOrigin = new URL(params.serverOrigin).origin;
  const infoResponse = await fetchImpl(new URL("/", `${serverOrigin}/`));
  if (!infoResponse.ok) {
    throw new Error(`Verifier server discovery failed with status ${infoResponse.status}.`);
  }
  const infoBody = (await infoResponse.json()) as { protectedResourceUrl?: unknown };
  const protectedResourceUrl = normalizeOptionalString(infoBody.protectedResourceUrl);
  if (!protectedResourceUrl) {
    throw new Error("Verifier server discovery response did not include `protectedResourceUrl`.");
  }

  const result = await requestAgentkitProtectedResource({
    resourceUrl: protectedResourceUrl,
    privateKey: normalizeOptionalString(params.privateKey) as Hex | undefined,
    fetchImpl,
  });

  return {
    serverOrigin,
    protectedResourceUrl,
    signerAddress: result.signerAddress,
    generatedPrivateKey: result.generatedPrivateKey,
    challengeStatus: result.challengeStatus,
    finalStatus: result.finalStatus,
    responseBody: result.responseBody,
  };
}

export function formatAgentkitVerifierRequestResult(result: AgentkitVerifierRequestResult): string {
  return [
    "AgentKit verifier request:",
    `- server origin: ${result.serverOrigin}`,
    formatAgentkitProtectedRequestResult({
      resourceUrl: result.protectedResourceUrl,
      challengeResourceUrl: result.protectedResourceUrl,
      signerAddress: result.signerAddress,
      generatedPrivateKey: result.generatedPrivateKey,
      headerName: AGENTKIT,
      challengeStatus: result.challengeStatus,
      finalStatus: result.finalStatus,
      responseBody: result.responseBody,
    })
      .split("\n")
      .slice(1)
      .map((line) => line.replace("- requested resource:", "- protected resource:"))
      .join("\n"),
  ].join("\n");
}
