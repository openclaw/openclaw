import { createServer, type ServerResponse } from "node:http";
import { AGENTKIT } from "./agentkit.runtime.js";
import type { AgentBookVerifier } from "./agentkit.runtime.js";
import { createTrustVerifiedSignerAgentBookVerifier } from "./local-agentbook.js";
import {
  createAgentkitProtectedResourceChallenge,
  DEFAULT_AGENTKIT_VERIFIER_NETWORK,
  DEFAULT_AGENTKIT_VERIFIER_RESOURCE_PATH,
  DEFAULT_AGENTKIT_VERIFIER_STATEMENT,
} from "./protected-challenge.js";
import { verifyAgentkitHeader, type AgentkitVerificationReport } from "./verify.js";

type AgentBookVerifierLike = Pick<AgentBookVerifier, "lookupHuman">;

export type AgentkitVerifierServerInfo = {
  origin: string;
  protectedResourceUrl: string;
  host: string;
  port: number;
  network: string;
  statement: string;
  humanLookupMode: string;
};

export type AgentkitVerifierServerHandle = {
  info: AgentkitVerifierServerInfo;
  close(): Promise<void>;
};

const DEFAULT_VERIFIER_HOST = "127.0.0.1";
const DEFAULT_LOCAL_HUMAN_LOOKUP_MODE = "local-trust-verified-signer";

function writeJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function buildChallengePayload(info: AgentkitVerifierServerInfo) {
  return createAgentkitProtectedResourceChallenge({
    resourceUrl: info.protectedResourceUrl,
    network: info.network,
    statement: info.statement,
  });
}

function buildServerInfo(params: {
  humanLookupMode?: string;
  host?: string;
  port?: number;
  resourcePath?: string;
  network?: string;
  statement?: string;
}): AgentkitVerifierServerInfo {
  const host = params.host ?? DEFAULT_VERIFIER_HOST;
  const port = params.port ?? 0;
  const resourcePath = params.resourcePath ?? DEFAULT_AGENTKIT_VERIFIER_RESOURCE_PATH;
  const normalizedResourcePath = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  const origin = `http://${host}:${port}`;
  return {
    origin,
    protectedResourceUrl: new URL(normalizedResourcePath, `${origin}/`).toString(),
    host,
    port,
    network: params.network ?? DEFAULT_AGENTKIT_VERIFIER_NETWORK,
    statement: params.statement ?? DEFAULT_AGENTKIT_VERIFIER_STATEMENT,
    humanLookupMode: params.humanLookupMode ?? DEFAULT_LOCAL_HUMAN_LOOKUP_MODE,
  };
}

export function formatAgentkitVerifierServerInfo(info: AgentkitVerifierServerInfo): string {
  return [
    "AgentKit verifier server:",
    `- origin: ${info.origin}`,
    `- protected resource: ${info.protectedResourceUrl}`,
    `- AgentKit network: ${info.network}`,
    `- human lookup mode: ${info.humanLookupMode}`,
    `- header name: ${AGENTKIT}`,
    "",
    "Next steps:",
    `- Run \`openclaw agentkit verifier-request --server ${info.origin}\` in another shell.`,
    `- Or request \`${info.protectedResourceUrl}\` without the \`${AGENTKIT}\` header to inspect a fresh challenge.`,
  ].join("\n");
}

async function verifyRequest(params: {
  agentBook?: AgentBookVerifierLike;
  humanLookupMode: string;
  resourceUrl: string;
  header: string;
}): Promise<AgentkitVerificationReport> {
  return await verifyAgentkitHeader({
    header: params.header,
    resourceUrl: params.resourceUrl,
    agentBook: params.agentBook ?? createTrustVerifiedSignerAgentBookVerifier(),
    humanLookupMode: params.humanLookupMode,
  });
}

export async function startAgentkitVerifierServer(
  params: {
    agentBook?: AgentBookVerifierLike;
    host?: string;
    humanLookupMode?: string;
    port?: number;
    resourcePath?: string;
    network?: string;
    statement?: string;
  } = {},
): Promise<AgentkitVerifierServerHandle> {
  const requestedInfo = buildServerInfo(params);
  const server = createServer(async (req, res) => {
    const hostHeader = req.headers.host ?? `${requestedInfo.host}:${requestedInfo.port}`;
    const origin = `http://${hostHeader}`;
    const protectedResourceUrl = new URL(
      new URL(requestedInfo.protectedResourceUrl).pathname,
      `${origin}/`,
    ).toString();

    if (!req.url) {
      writeJson(res, 400, { ok: false, error: "Missing request URL." });
      return;
    }

    const requestUrl = new URL(req.url, `${origin}/`);
    if (req.method === "GET" && requestUrl.pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        mode: requestedInfo.humanLookupMode,
        headerName: AGENTKIT,
        protectedResourceUrl,
        network: requestedInfo.network,
        statement: requestedInfo.statement,
      });
      return;
    }

    if (requestUrl.pathname !== new URL(requestedInfo.protectedResourceUrl).pathname) {
      writeJson(res, 404, { ok: false, error: "Not found." });
      return;
    }

    const challenge = buildChallengePayload({
      ...requestedInfo,
      origin,
      protectedResourceUrl,
    });
    const rawHeader = req.headers[AGENTKIT] ?? req.headers[AGENTKIT.toLowerCase()];
    const header =
      typeof rawHeader === "string" ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;

    if (!header) {
      writeJson(res, 401, {
        ok: false,
        error: `Missing ${AGENTKIT} header.`,
        headerName: AGENTKIT,
        resourceUrl: protectedResourceUrl,
        challenge,
      });
      return;
    }

    const report = await verifyRequest({
      agentBook: params.agentBook,
      humanLookupMode: params.humanLookupMode ?? DEFAULT_LOCAL_HUMAN_LOOKUP_MODE,
      resourceUrl: protectedResourceUrl,
      header,
    });
    if (report.outcome === "verified") {
      writeJson(res, 200, {
        ok: true,
        mode: requestedInfo.humanLookupMode,
        report,
      });
      return;
    }

    writeJson(res, 403, {
      ok: false,
      report,
      challenge,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedInfo.port, requestedInfo.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("AgentKit verifier server failed to bind to a loopback TCP port.");
  }

  const info = buildServerInfo({
    host: address.address,
    humanLookupMode: params.humanLookupMode,
    port: address.port,
    resourcePath: new URL(requestedInfo.protectedResourceUrl).pathname,
    network: requestedInfo.network,
    statement: requestedInfo.statement,
  });

  return {
    info,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
