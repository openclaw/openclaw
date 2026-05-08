import { createHash } from "node:crypto";
import type { AgentkitPluginConfig } from "./config.js";
import type { AgentkitPendingApproval } from "./hitl-approvals.js";
import { renderQrCodeInTerminal } from "./qr.runtime.js";
import {
  loadWorldIdCoreRuntime,
  withWorldIdCoreFileFetchCompat,
  type WorldIdCoreRuntime,
} from "./world-id.runtime.js";

type AgentkitHumanApprovalRequestConfigBase = {
  environment: "production" | "staging";
  actionPrefix: string;
};

export type AgentkitHumanApprovalRequestConfig =
  | (AgentkitHumanApprovalRequestConfigBase & {
      provider: "hosted";
      brokerUrl: string;
    })
  | (AgentkitHumanApprovalRequestConfigBase & {
      provider: "custom";
      brokerUrl: string | null;
      appId: `app_${string}`;
      rpId: string;
      signingKeyHex: string;
    });

type AgentkitWorldRpSignature = {
  appId: `app_${string}`;
  rpId: string;
  environment: "production" | "staging";
  nonce: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
};

export type AgentkitHumanApprovalSessionResult = {
  success: boolean;
  action: string;
  approvalId: string;
  connectorURI: string;
  requestId: string;
  verifyStatus: number | null;
  verifyBody: unknown;
  errorCode: string | null;
  nullifier: string | null;
};

export type AgentkitHumanApprovalSession = {
  approvalId: string;
  action: string;
  connectorURI: string;
  requestId: string;
  waitForCompletion: () => Promise<AgentkitHumanApprovalSessionResult>;
};

export type AgentkitHumanApprovalPendingSession = Omit<
  AgentkitHumanApprovalSession,
  "waitForCompletion"
>;

type FetchImpl = typeof fetch;
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function buildApprovalActionPrefix(prefix: string): string {
  const normalized = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "openclaw-approval";
}

function extractApprovalNullifier(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  const responses = record.responses;
  if (!Array.isArray(responses) || responses.length === 0) {
    return null;
  }
  const first = asRecord(responses[0]);
  if (!first) {
    return null;
  }
  return typeof first.nullifier === "string" && first.nullifier.trim() ? first.nullifier : null;
}

function extractStringField(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const field = record[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function extractBrokerStringField(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function extractBrokerNumberField(record: UnknownRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeHostedBrokerUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      "World human approval broker URL is invalid. Set `plugins.entries.agentkit.config.hitl.humanApproval.brokerUrl` to an HTTPS URL.",
    );
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    return url.toString();
  }
  throw new Error(
    "World human approval broker URL must use HTTPS. HTTP is allowed only for localhost development.",
  );
}

function extractBrokerError(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  for (const key of ["code", "error", "message", "detail"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

function parseHostedBrokerSignature(params: {
  body: unknown;
  environment: "production" | "staging";
}): AgentkitWorldRpSignature {
  const record = asRecord(params.body);
  if (!record) {
    throw new Error("World human approval broker returned an invalid response.");
  }
  const appId = extractBrokerStringField(record, ["appId", "app_id"]);
  const rpId = extractBrokerStringField(record, ["rpId", "rp_id"]);
  const nonce = extractBrokerStringField(record, ["nonce"]);
  const createdAt = extractBrokerNumberField(record, ["createdAt", "created_at"]);
  const expiresAt = extractBrokerNumberField(record, ["expiresAt", "expires_at"]);
  const signature = extractBrokerStringField(record, ["signature", "sig"]);
  const environmentRaw = extractBrokerStringField(record, ["environment"]);
  const environment =
    environmentRaw === "production" || environmentRaw === "staging"
      ? environmentRaw
      : params.environment;
  if (!appId?.startsWith("app_") || !rpId || !nonce || !createdAt || !expiresAt || !signature) {
    throw new Error("World human approval broker returned an incomplete signature response.");
  }
  return {
    appId: appId as `app_${string}`,
    rpId,
    environment,
    nonce,
    createdAt,
    expiresAt,
    signature,
  };
}

function verifyWorldCompletionResult(params: {
  action: string;
  environment: "production" | "staging";
  nonce: string;
  result: unknown;
}): string | null {
  const nonce = extractStringField(params.result, "nonce");
  if (nonce !== params.nonce) {
    return "unexpected_nonce";
  }
  const environment = extractStringField(params.result, "environment");
  if (environment && environment !== params.environment) {
    return "unexpected_environment";
  }
  const action = extractStringField(params.result, "action");
  if (action && action !== params.action) {
    return "unexpected_action";
  }
  return null;
}

function isSuccessfulVerifyBody(value: unknown): boolean {
  const record = asRecord(value);
  return record?.success === true;
}

function buildWorldHumanApprovalAction(approvalId: string, actionPrefix: string): string {
  const suffix = createHash("sha256").update(approvalId).digest("hex").slice(0, 24);
  return `${buildApprovalActionPrefix(actionPrefix)}-${suffix}`;
}

function buildWorldHumanApprovalDescription(approval: AgentkitPendingApproval): string {
  const toolLabel = approval.request.toolName ?? "this action";
  return `Approve ${toolLabel} in OpenClaw`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function resolveAgentkitHumanApprovalRequestConfig(params: {
  pluginConfig: AgentkitPluginConfig;
  env?: NodeJS.ProcessEnv;
}): AgentkitHumanApprovalRequestConfig {
  const humanApproval = params.pluginConfig.hitl.humanApproval;
  if (humanApproval.provider === "hosted") {
    if (!humanApproval.brokerUrl) {
      throw new Error(
        "World human approval broker URL is not configured. Set `plugins.entries.agentkit.config.hitl.humanApproval.brokerUrl`.",
      );
    }
    return {
      provider: "hosted",
      brokerUrl: normalizeHostedBrokerUrl(humanApproval.brokerUrl),
      environment: humanApproval.environment,
      actionPrefix: humanApproval.actionPrefix,
    };
  }
  if (!humanApproval.appId) {
    throw new Error(
      "World human approval app ID is not configured. Set `plugins.entries.agentkit.config.hitl.humanApproval.appId`.",
    );
  }
  if (!humanApproval.rpId) {
    throw new Error(
      "World human approval RP ID is not configured. Set `plugins.entries.agentkit.config.hitl.humanApproval.rpId`.",
    );
  }
  const signingKeyFromEnv = humanApproval.signingKeyEnvVar
    ? (params.env?.[humanApproval.signingKeyEnvVar] ?? null)
    : null;
  const signingKeyHex = signingKeyFromEnv ?? humanApproval.signingKey ?? null;
  if (!signingKeyHex) {
    throw new Error(
      "World human approval signing key is not configured. Set `plugins.entries.agentkit.config.hitl.humanApproval.signingKeyEnvVar` and provide that environment variable. Inline `signingKey` remains supported, but is not recommended for shared config.",
    );
  }
  return {
    provider: "custom",
    brokerUrl: humanApproval.brokerUrl,
    appId: humanApproval.appId as `app_${string}`,
    rpId: humanApproval.rpId,
    signingKeyHex,
    environment: humanApproval.environment,
    actionPrefix: humanApproval.actionPrefix,
  };
}

async function requestHostedWorldApprovalSignature(params: {
  action: string;
  actionDescription: string;
  brokerUrl: string;
  environment: "production" | "staging";
  fetchImpl: FetchImpl;
  ttlSeconds: number;
}): Promise<AgentkitWorldRpSignature> {
  const response = await params.fetchImpl(params.brokerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenClaw AgentKit HITL",
    },
    body: JSON.stringify({
      action: params.action,
      action_description: params.actionDescription,
      ttl: params.ttlSeconds,
      environment: params.environment,
    }),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    const detail = extractBrokerError(body);
    throw new Error(
      detail
        ? `World human approval broker request failed with status ${response.status}: ${detail}`
        : `World human approval broker request failed with status ${response.status}.`,
    );
  }
  return parseHostedBrokerSignature({
    body,
    environment: params.environment,
  });
}

async function resolveWorldApprovalSignature(params: {
  action: string;
  actionDescription: string;
  config: AgentkitHumanApprovalRequestConfig;
  fetchImpl: FetchImpl;
  runtime: WorldIdCoreRuntime;
  ttlSeconds: number;
}): Promise<AgentkitWorldRpSignature> {
  if (params.config.provider === "hosted") {
    return await requestHostedWorldApprovalSignature({
      action: params.action,
      actionDescription: params.actionDescription,
      brokerUrl: params.config.brokerUrl,
      environment: params.config.environment,
      fetchImpl: params.fetchImpl,
      ttlSeconds: params.ttlSeconds,
    });
  }
  const rpSignature = params.runtime.signRequest({
    signingKeyHex: params.config.signingKeyHex,
    action: params.action,
    ttl: params.ttlSeconds,
  });
  return {
    appId: params.config.appId,
    rpId: params.config.rpId,
    environment: params.config.environment,
    nonce: rpSignature.nonce,
    createdAt: rpSignature.createdAt,
    expiresAt: rpSignature.expiresAt,
    signature: rpSignature.sig,
  };
}

export async function runAgentkitWorldHumanApproval(params: {
  approval: AgentkitPendingApproval;
  pluginConfig: AgentkitPluginConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  logLine?: (line: string) => void;
  onPending?: (session: AgentkitHumanApprovalPendingSession) => Promise<void> | void;
  renderQrCode?: (input: string) => Promise<void>;
  worldIdRuntime?: WorldIdCoreRuntime;
  timeoutMs?: number;
}): Promise<AgentkitHumanApprovalSessionResult> {
  const session = await startAgentkitWorldHumanApprovalSession(params);
  await params.onPending?.({
    approvalId: session.approvalId,
    action: session.action,
    connectorURI: session.connectorURI,
    requestId: session.requestId,
  });
  const logLine = params.logLine ?? console.log;
  const renderQrCode = params.renderQrCode ?? renderQrCodeInTerminal;
  if (process.stdout.isTTY) {
    logLine("Scan this QR with World App to approve the pending OpenClaw action:");
    await renderQrCode(session.connectorURI);
  }
  logLine(`World approval link: ${session.connectorURI}`);
  return await session.waitForCompletion();
}

export async function startAgentkitWorldHumanApprovalSession(params: {
  approval: AgentkitPendingApproval;
  pluginConfig: AgentkitPluginConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  worldIdRuntime?: WorldIdCoreRuntime;
  timeoutMs?: number;
}): Promise<AgentkitHumanApprovalSession> {
  const requestConfig = resolveAgentkitHumanApprovalRequestConfig({
    pluginConfig: params.pluginConfig,
    env: params.env,
  });
  const runtime = params.worldIdRuntime ?? (await loadWorldIdCoreRuntime());
  const fetchImpl = params.fetchImpl ?? fetch;

  const action = buildWorldHumanApprovalAction(params.approval.id, requestConfig.actionPrefix);
  const actionDescription = buildWorldHumanApprovalDescription(params.approval);
  const ttlSeconds = Math.max(
    30,
    Math.ceil((params.timeoutMs ?? params.pluginConfig.hitl.timeoutMs) / 1000),
  );
  const rpSignature = await resolveWorldApprovalSignature({
    action,
    actionDescription,
    config: requestConfig,
    fetchImpl,
    runtime,
    ttlSeconds,
  });

  const request = await withWorldIdCoreFileFetchCompat(() =>
    runtime.IDKit.request({
      app_id: rpSignature.appId,
      action,
      action_description: actionDescription,
      rp_context: {
        rp_id: rpSignature.rpId,
        nonce: rpSignature.nonce,
        created_at: rpSignature.createdAt,
        expires_at: rpSignature.expiresAt,
        signature: rpSignature.signature,
      },
      allow_legacy_proofs: true,
      environment: rpSignature.environment,
    }).preset(runtime.orbLegacy()),
  );
  return {
    approvalId: params.approval.id,
    action,
    connectorURI: request.connectorURI,
    requestId: request.requestId,
    waitForCompletion: async () => {
      const completion = await request.pollUntilCompletion({
        timeout: Math.max(1_000, (params.timeoutMs ?? params.pluginConfig.hitl.timeoutMs) - 1_000),
      });
      if (!completion.success) {
        return {
          success: false,
          action,
          approvalId: params.approval.id,
          connectorURI: request.connectorURI,
          requestId: request.requestId,
          verifyStatus: null,
          verifyBody: null,
          errorCode: completion.error,
          nullifier: null,
        };
      }
      const proofError = verifyWorldCompletionResult({
        action,
        environment: rpSignature.environment,
        nonce: rpSignature.nonce,
        result: completion.result,
      });
      if (proofError) {
        return {
          success: false,
          action,
          approvalId: params.approval.id,
          connectorURI: request.connectorURI,
          requestId: request.requestId,
          verifyStatus: null,
          verifyBody: null,
          errorCode: proofError,
          nullifier: null,
        };
      }
      const nullifier = extractApprovalNullifier(completion.result);
      if (!nullifier) {
        return {
          success: false,
          action,
          approvalId: params.approval.id,
          connectorURI: request.connectorURI,
          requestId: request.requestId,
          verifyStatus: null,
          verifyBody: null,
          errorCode: "missing_nullifier",
          nullifier: null,
        };
      }

      const verifyResponse = await fetchImpl(
        `https://developer.worldcoin.org/api/v4/verify/${rpSignature.rpId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "OpenClaw AgentKit HITL",
          },
          body: JSON.stringify(completion.result),
        },
      );
      const verifyBody = await parseJsonResponse(verifyResponse);
      const verifySuccess = verifyResponse.ok && isSuccessfulVerifyBody(verifyBody);
      return {
        success: verifySuccess,
        action,
        approvalId: params.approval.id,
        connectorURI: request.connectorURI,
        requestId: request.requestId,
        verifyStatus: verifyResponse.status,
        verifyBody,
        errorCode: null,
        nullifier,
      };
    },
  };
}
