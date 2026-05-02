import { createHmac } from "node:crypto";
import {
  normalizeBaseUrl,
  resolveAuthorityToken,
  resolveOperatorSigningKey,
  type ZekePluginConfig,
} from "./config.js";

export type ZekeFlowClientOptions = {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export class ZekeFlowClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZekeFlowClientError";
  }
}

function redactToken(message: string, token: string): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

export async function callZekeFlowTool(
  config: ZekePluginConfig,
  toolName: string,
  args: Record<string, unknown>,
  meta: { toolCallId?: string; sessionKey?: string } = {},
  options: ZekeFlowClientOptions = {},
): Promise<unknown> {
  const token = resolveAuthorityToken(config, options.env);
  if (!token) {
    throw new ZekeFlowClientError(`Missing ZekeFlow authority token env: ${config.tokenEnv}`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ZekeFlowClientError("fetch is unavailable for ZekeFlow authority calls");
  }

  const url = `${normalizeBaseUrl(config.baseUrl)}/internal/openclaw/tools/${encodeURIComponent(toolName)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-zeke-openclaw-profile": config.profile,
      },
      body: JSON.stringify({
        arguments: scrubModelIdentityArgs(args),
        tool_call_id: meta.toolCallId,
        session_key: meta.sessionKey,
      }),
    });
  } catch (error) {
    throw new ZekeFlowClientError(
      redactToken(`ZekeFlow authority request failed: ${String(error)}`, token),
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `ZekeFlow authority returned HTTP ${response.status}`;
    throw new ZekeFlowClientError(redactToken(message, token), response.status);
  }

  return payload && typeof payload === "object" && "result" in payload
    ? (payload as { result: unknown }).result
    : payload;
}

export async function replyToZekeProposal(
  config: ZekePluginConfig,
  params: { text: string; sessionKey?: string; operatorId: string },
  options: ZekeFlowClientOptions = {},
): Promise<unknown> {
  const token = resolveAuthorityToken(config, options.env);
  if (!token) {
    throw new ZekeFlowClientError(`Missing ZekeFlow authority token env: ${config.tokenEnv}`);
  }
  const signingKey = resolveOperatorSigningKey(config, options.env);
  if (!signingKey) {
    throw new ZekeFlowClientError(
      `Missing ZekeFlow operator signing key env: ${config.operatorSigningKeyEnv}`,
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/internal/openclaw/proposals/reply`;
  const signature = operatorSignature({
    profile: config.profile,
    sessionKey: params.sessionKey,
    text: params.text,
    operatorId: params.operatorId,
    signingKey,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-zeke-openclaw-profile": config.profile,
      "x-zeke-operator-id": params.operatorId,
      "x-zeke-operator-signature": signature,
    },
    body: JSON.stringify({
      text: params.text,
      session_key: params.sessionKey,
      message_origin: "operator",
      decided_by: params.operatorId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `ZekeFlow proposal reply returned HTTP ${response.status}`;
    throw new ZekeFlowClientError(redactToken(message, token), response.status);
  }
  return payload;
}

export function operatorSignature(params: {
  profile: string;
  sessionKey?: string;
  text: string;
  operatorId: string;
  signingKey: string;
}): string {
  return createHmac("sha256", params.signingKey)
    .update(
      `${params.profile}\n${params.sessionKey || ""}\n${params.text || ""}\n${params.operatorId || ""}`,
    )
    .digest("hex");
}

export function scrubModelIdentityArgs(args: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...args };
  delete cleaned.caller;
  delete cleaned.entity;
  delete cleaned.profile;
  delete cleaned.callerContext;
  delete cleaned.envelope;
  return cleaned;
}
