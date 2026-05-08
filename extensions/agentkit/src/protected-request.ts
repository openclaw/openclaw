import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AGENTKIT } from "./agentkit.runtime.js";
import type { AgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import { buildAgentkitProtectedHeader } from "./protected-header.js";
import { resolveOptionalTextInputValue } from "./text-input.js";
import { type Hex } from "./viem.runtime.js";

type FetchImpl = typeof fetch;

const PRIVATE_KEY_PATTERN = /^0x[0-9a-f]{64}$/iu;

export type AgentkitProtectedRequestResult = {
  resourceUrl: string;
  challengeResourceUrl: string;
  signerAddress: string;
  generatedPrivateKey: boolean;
  headerName: string;
  challengeStatus: number;
  finalStatus: number;
  responseBody: unknown;
};

export type PreparedAgentkitProtectedRequest = {
  resourceUrl: string;
  challengeResourceUrl: string;
  signerAddress: string;
  generatedPrivateKey: boolean;
  headerName: string;
  headerValue: string;
  challengeStatus: number;
};

type AgentkitChallengeEnvelope = {
  resourceUrl: string;
  challenge: AgentkitProtectedResourceChallenge;
  headerName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAgentkitProtectedResourceChallenge(
  value: unknown,
): value is AgentkitProtectedResourceChallenge {
  if (!isRecord(value) || !isRecord(value.info)) {
    return false;
  }
  const info = value.info;
  return (
    typeof info.domain === "string" &&
    typeof info.uri === "string" &&
    typeof info.version === "string" &&
    typeof info.nonce === "string" &&
    typeof info.issuedAt === "string" &&
    Array.isArray(value.supportedChains) &&
    isRecord(value.schema)
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    return JSON.parse(text) as unknown;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function resolveChallengeResourceUrl(params: {
  challenge: AgentkitProtectedResourceChallenge;
  fallbackResourceUrl: string;
}): string {
  const challengeResourceUrl = normalizeOptionalString(params.challenge.info.uri);
  return new URL(challengeResourceUrl ?? params.fallbackResourceUrl).toString();
}

function asAgentkitChallengeEnvelope(params: {
  value: unknown;
  fallbackResourceUrl: string;
}): AgentkitChallengeEnvelope {
  const { value } = params;
  if (!isRecord(value)) {
    throw new Error("AgentKit challenge response was not valid JSON.");
  }

  if ("resourceUrl" in value || "challenge" in value) {
    const resourceUrl = normalizeOptionalString(value.resourceUrl);
    if (!resourceUrl) {
      throw new Error("AgentKit challenge response did not include `resourceUrl`.");
    }

    if (!isAgentkitProtectedResourceChallenge(value.challenge)) {
      throw new Error("AgentKit challenge response did not include a valid `challenge`.");
    }

    const headerName = normalizeOptionalString(value.headerName) ?? AGENTKIT;
    return {
      resourceUrl: new URL(resourceUrl).toString(),
      challenge: value.challenge,
      headerName,
    };
  }

  const extensions = isRecord(value.extensions) ? value.extensions : null;
  const extension = extensions?.[AGENTKIT];
  if (!isAgentkitProtectedResourceChallenge(extension)) {
    throw new Error("AgentKit challenge response did not include a valid AgentKit extension.");
  }

  return {
    resourceUrl: resolveChallengeResourceUrl({
      challenge: extension,
      fallbackResourceUrl: params.fallbackResourceUrl,
    }),
    challenge: extension,
    headerName: AGENTKIT,
  };
}

function withAgentkitHeader(
  requestInit: RequestInit | undefined,
  headerName: string,
  headerValue: string,
): RequestInit {
  const headers = new Headers(requestInit?.headers);
  headers.set(headerName, headerValue);
  return {
    ...requestInit,
    headers,
  };
}

export async function resolveAgentkitPrivateKeyValue(params: {
  privateKey?: string;
  privateKeyFile?: string;
}): Promise<Hex | undefined> {
  const privateKey = await resolveOptionalTextInputValue({
    value: params.privateKey,
    file: params.privateKeyFile,
    valueOptionLabel: "--private-key <hex>",
    fileOptionLabel: "--private-key-file <path>",
    valueLabel: "AgentKit private key",
  });
  if (!privateKey) {
    return undefined;
  }
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error("AgentKit private key must be a 32-byte hex string with a `0x` prefix.");
  }
  return privateKey as Hex;
}

export async function requestAgentkitProtectedResource(params: {
  resourceUrl: string;
  privateKey?: Hex;
  fetchImpl?: FetchImpl;
  requestInitFactory?: () => RequestInit;
}): Promise<AgentkitProtectedRequestResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestInitFactory = params.requestInitFactory ?? (() => ({}));

  const prepared = await prepareAgentkitProtectedRequest({
    resourceUrl: params.resourceUrl,
    privateKey: params.privateKey,
    fetchImpl,
    requestInitFactory,
  });

  const finalResponse = await fetchImpl(
    prepared.challengeResourceUrl,
    withAgentkitHeader(requestInitFactory(), prepared.headerName, prepared.headerValue),
  );

  return {
    resourceUrl: prepared.resourceUrl,
    challengeResourceUrl: prepared.challengeResourceUrl,
    signerAddress: prepared.signerAddress,
    generatedPrivateKey: prepared.generatedPrivateKey,
    headerName: prepared.headerName,
    challengeStatus: prepared.challengeStatus,
    finalStatus: finalResponse.status,
    responseBody: await readResponseBody(finalResponse),
  };
}

export async function prepareAgentkitProtectedRequest(params: {
  resourceUrl: string;
  privateKey?: Hex;
  fetchImpl?: FetchImpl;
  requestInitFactory?: () => RequestInit;
}): Promise<PreparedAgentkitProtectedRequest> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestInitFactory = params.requestInitFactory ?? (() => ({}));
  const resourceUrl = new URL(params.resourceUrl).toString();

  const challengeResponse = await fetchImpl(resourceUrl, requestInitFactory());
  const challengeBody = await readResponseBody(challengeResponse);
  if (challengeResponse.status !== 401 && challengeResponse.status !== 402) {
    throw new Error(
      `Expected AgentKit challenge response status 401 or 402, got ${challengeResponse.status}.`,
    );
  }
  const challengeEnvelope = asAgentkitChallengeEnvelope({
    value: challengeBody,
    fallbackResourceUrl: resourceUrl,
  });

  const signed = await buildAgentkitProtectedHeader({
    challenge: challengeEnvelope.challenge,
    privateKey: params.privateKey,
  });

  return {
    resourceUrl,
    challengeResourceUrl: challengeEnvelope.resourceUrl,
    signerAddress: signed.address,
    generatedPrivateKey: signed.generatedPrivateKey,
    headerName: challengeEnvelope.headerName,
    headerValue: signed.header,
    challengeStatus: challengeResponse.status,
  };
}

export function formatAgentkitProtectedRequestResult(
  result: AgentkitProtectedRequestResult,
): string {
  return [
    "AgentKit protected request:",
    `- requested resource: ${result.resourceUrl}`,
    `- challenge resource: ${result.challengeResourceUrl}`,
    `- header name: ${result.headerName}`,
    `- signer address: ${result.signerAddress}`,
    `- signer source: ${result.generatedPrivateKey ? "generated ephemeral key" : "user-supplied private key"}`,
    `- challenge response: ${result.challengeStatus}`,
    `- final response: ${result.finalStatus}`,
    `- verified: ${result.finalStatus === 200 ? "yes" : "no"}`,
  ].join("\n");
}
