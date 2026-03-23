import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { jsonResult, readStringParam, ToolInputError } from "../../../src/agents/tools/common.js";
import { resolveStorePath } from "../../../src/config/sessions/paths.js";
import { loadSessionStore } from "../../../src/config/sessions/store.js";
import { callGateway } from "../../../src/gateway/call.js";
import { deliverOutboundPayloads } from "../../../src/infra/outbound/deliver.js";
import { resolveSessionDeliveryTarget } from "../../../src/infra/outbound/targets.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";

const DEFAULT_SERVICE_URL = "https://pythia-mcp.fly.dev/";
const DEFAULT_SERVICE_NAME = "Pythia Oracle";
const DEFAULT_EXPECTED_PRICE_USD = 0.025;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_WALLET_ENV_VAR = "PYTHIA_BASE_PRIVATE_KEY";

type PythiaPluginConfig = {
  url: string;
  serviceName: string;
  walletPrivateKeyEnvVar: string;
  defaultAgentId: string;
  expectedPriceUsd: number;
  autoApproveUnderUsd?: number;
  dailyBudgetUsd?: number;
  totalBudgetUsd?: number;
  approvalTimeoutMs: number;
  allowAlwaysCache: boolean;
};

type PythiaPaymentState = {
  version: 1;
  dailySpendUsd?: Record<string, number>;
  grants?: Record<string, { createdAtMs: number }>;
  history?: Array<{
    ts: number;
    usd?: number;
    transaction?: string;
    network: string;
    asset: string;
    payTo: string;
  }>;
};

type PaymentRequirementLike = {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
};

type MpcInitializeResponse = {
  result?: {
    protocolVersion?: string;
  };
  error?: {
    message?: string;
  };
};

type ToolCallContentItem = {
  type?: string;
  text?: string;
};

type ToolCallResponse = {
  result?: {
    structuredContent?: unknown;
    content?: ToolCallContentItem[];
    isError?: boolean;
  };
  error?: {
    message?: string;
  };
};

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePluginConfig(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
): PythiaPluginConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const defaultAgentId =
    (typeof raw.defaultAgentId === "string" && raw.defaultAgentId.trim()) ||
    ctx.agentId ||
    "anonymous";
  return {
    url: (typeof raw.url === "string" && raw.url.trim()) || DEFAULT_SERVICE_URL,
    serviceName:
      (typeof raw.serviceName === "string" && raw.serviceName.trim()) || DEFAULT_SERVICE_NAME,
    walletPrivateKeyEnvVar:
      (typeof raw.walletPrivateKeyEnvVar === "string" && raw.walletPrivateKeyEnvVar.trim()) ||
      DEFAULT_WALLET_ENV_VAR,
    defaultAgentId,
    expectedPriceUsd: parsePositiveNumber(raw.expectedPriceUsd) ?? DEFAULT_EXPECTED_PRICE_USD,
    autoApproveUnderUsd: parsePositiveNumber(raw.autoApproveUnderUsd),
    dailyBudgetUsd: parsePositiveNumber(raw.dailyBudgetUsd),
    totalBudgetUsd: parsePositiveNumber(raw.totalBudgetUsd),
    approvalTimeoutMs: parsePositiveNumber(raw.approvalTimeoutMs) ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    allowAlwaysCache: parseBoolean(raw.allowAlwaysCache, true),
  };
}

function resolveStateFilePath(ctx: OpenClawPluginToolContext): string {
  const base = ctx.agentDir ?? ctx.workspaceDir ?? process.cwd();
  return path.join(base, "payments", "pythia-oracle.json");
}

async function loadPaymentState(statePath: string): Promise<PythiaPaymentState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PythiaPaymentState>;
    return {
      version: 1,
      dailySpendUsd:
        parsed.dailySpendUsd && typeof parsed.dailySpendUsd === "object"
          ? parsed.dailySpendUsd
          : {},
      grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {},
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 100) : [],
    };
  } catch {
    return {
      version: 1,
      dailySpendUsd: {},
      grants: {},
      history: [],
    };
  }
}

async function savePaymentState(statePath: string, state: PythiaPaymentState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function currentUtcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function buildGrantKey(req: PaymentRequirementLike): string {
  return [req.network, req.asset.toLowerCase(), req.payTo.toLowerCase()].join("|");
}

function readWalletPrivateKey(envVar: string): `0x${string}` | undefined {
  const value = process.env[envVar]?.trim();
  if (!value) {
    return undefined;
  }
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

function formatUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  const rounded = value < 0.1 ? value.toFixed(3) : value.toFixed(2);
  return `$${rounded}`;
}

function buildPaymentCommandLabel(config: PythiaPluginConfig): string {
  return `x402 payment for ${config.serviceName} (${formatUsd(config.expectedPriceUsd)})`;
}

function buildApprovalPrompt(params: {
  id: string;
  config: PythiaPluginConfig;
  req: PaymentRequirementLike;
  agentId?: string;
  expiresAtMs?: number;
}): string {
  const expiresInSeconds =
    params.expiresAtMs && Number.isFinite(params.expiresAtMs)
      ? Math.max(0, Math.round((params.expiresAtMs - Date.now()) / 1000))
      : Math.round(params.config.approvalTimeoutMs / 1000);
  return [
    "Payment approval required",
    `ID: ${params.id}`,
    `Service: ${params.config.serviceName}`,
    `Price: about ${formatUsd(params.config.expectedPriceUsd)} on ${params.req.network}`,
    `Asset: ${params.req.asset}`,
    `Pay to: ${params.req.payTo}`,
    params.agentId ? `Agent: ${params.agentId}` : undefined,
    `Expires in: ${expiresInSeconds}s`,
    "Reply with: /approve <id> allow-once|allow-always|deny",
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendPromptToSession(params: {
  cfg: NonNullable<OpenClawPluginToolContext["config"]>;
  agentId?: string;
  sessionKey?: string;
  text: string;
}): Promise<boolean> {
  if (!params.sessionKey) {
    return false;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  if (!entry) {
    return false;
  }
  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
  });
  if (!target.channel || !target.to) {
    return false;
  }
  await deliverOutboundPayloads({
    cfg: params.cfg,
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
    agentId: params.agentId,
    payloads: [{ text: params.text }],
  });
  return true;
}

function hasDailyBudgetCapacity(params: {
  state: PythiaPaymentState;
  dailyBudgetUsd?: number;
  expectedPriceUsd?: number;
}): boolean {
  if (params.dailyBudgetUsd === undefined || params.expectedPriceUsd === undefined) {
    return true;
  }
  const spent = params.state.dailySpendUsd?.[currentUtcDayKey()] ?? 0;
  return spent + params.expectedPriceUsd <= params.dailyBudgetUsd + Number.EPSILON;
}

function hasTotalBudgetCapacity(params: {
  state: PythiaPaymentState;
  totalBudgetUsd?: number;
  expectedPriceUsd?: number;
}): boolean {
  if (params.totalBudgetUsd === undefined || params.expectedPriceUsd === undefined) {
    return true;
  }
  const spent = (params.state.history ?? []).reduce((sum, entry) => sum + (entry.usd ?? 0), 0);
  return spent + params.expectedPriceUsd <= params.totalBudgetUsd + Number.EPSILON;
}

async function createApprovalGate(params: {
  api: OpenClawPluginApi;
  ctx: OpenClawPluginToolContext;
  config: PythiaPluginConfig;
  statePath: string;
}) {
  const { api, ctx, config, statePath } = params;
  return async (req: PaymentRequirementLike): Promise<void | { abort: true; reason: string }> => {
    const state = await loadPaymentState(statePath);
    const grantKey = buildGrantKey(req);
    const expectedPriceUsd = config.expectedPriceUsd;

    if (
      !hasDailyBudgetCapacity({ state, dailyBudgetUsd: config.dailyBudgetUsd, expectedPriceUsd })
    ) {
      return {
        abort: true,
        reason: `${config.serviceName} daily payment budget exceeded (${formatUsd(config.dailyBudgetUsd)}).`,
      };
    }
    if (
      !hasTotalBudgetCapacity({ state, totalBudgetUsd: config.totalBudgetUsd, expectedPriceUsd })
    ) {
      return {
        abort: true,
        reason: `${config.serviceName} total payment budget exceeded (${formatUsd(config.totalBudgetUsd)}).`,
      };
    }

    if (state.grants?.[grantKey]) {
      api.logger.info?.(`pythia-oracle: using cached allow-always grant for ${grantKey}`);
      return;
    }

    if (
      config.autoApproveUnderUsd !== undefined &&
      expectedPriceUsd <= config.autoApproveUnderUsd + Number.EPSILON
    ) {
      api.logger.info?.(
        `pythia-oracle: auto-approved payment ${formatUsd(expectedPriceUsd)} under threshold ${formatUsd(config.autoApproveUnderUsd)}`,
      );
      return;
    }

    if (!ctx.config) {
      return {
        abort: true,
        reason: `${config.serviceName} payment approval requires config context.`,
      };
    }
    if (!ctx.sessionKey) {
      return {
        abort: true,
        reason: `${config.serviceName} payment approval requires a live chat session.`,
      };
    }

    const accepted = await callGateway<{
      id: string;
      expiresAtMs?: number;
      status?: string;
    }>({
      method: "exec.approval.request",
      params: {
        command: buildPaymentCommandLabel(config),
        cwd: "payment:pythia-oracle",
        host: config.url,
        security: "payment",
        ask: "always",
        agentId: ctx.agentId,
        timeoutMs: config.approvalTimeoutMs,
        twoPhase: true,
      },
    });

    const prompt = buildApprovalPrompt({
      id: accepted.id,
      config,
      req,
      agentId: ctx.agentId,
      expiresAtMs: accepted.expiresAtMs,
    });
    const delivered = await sendPromptToSession({
      cfg: ctx.config,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      text: prompt,
    }).catch((error) => {
      api.logger.warn(`pythia-oracle: failed to send approval prompt: ${String(error)}`);
      return false;
    });

    if (!delivered) {
      return {
        abort: true,
        reason: `${config.serviceName} payment approval could not be delivered to the active chat.`,
      };
    }

    const decision = await callGateway<{ decision: "allow-once" | "allow-always" | "deny" | null }>(
      {
        method: "exec.approval.waitDecision",
        params: { id: accepted.id },
        timeoutMs: config.approvalTimeoutMs + 5_000,
      },
    );

    if (decision.decision === "allow-always" && config.allowAlwaysCache) {
      state.grants = {
        ...(state.grants ?? {}),
        [grantKey]: { createdAtMs: Date.now() },
      };
      await savePaymentState(statePath, state);
      return;
    }

    if (decision.decision !== "allow-once") {
      return {
        abort: true,
        reason:
          decision.decision === null
            ? `${config.serviceName} payment approval timed out.`
            : `${config.serviceName} payment was denied.`,
      };
    }
  };
}

async function openMcpSession(params: {
  fetchImpl: typeof fetch;
  url: string;
  clientName: string;
  clientVersion: string;
}): Promise<string> {
  const initializeResponse = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: params.clientName,
          version: params.clientVersion,
        },
      },
    }),
  });

  if (!initializeResponse.ok) {
    throw new Error(`Pythia initialize failed with HTTP ${initializeResponse.status}`);
  }

  const sessionId = initializeResponse.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("Pythia initialize did not return Mcp-Session-Id");
  }

  const initializeBody = (await initializeResponse.json()) as MpcInitializeResponse;
  if (initializeBody.error?.message) {
    throw new Error(initializeBody.error.message);
  }

  const initializedResponse = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });

  if (!initializedResponse.ok) {
    throw new Error(
      `Pythia initialized notification failed with HTTP ${initializedResponse.status}`,
    );
  }

  const listResponse = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/list",
      params: {},
    }),
  });

  if (!listResponse.ok) {
    throw new Error(`Pythia tools/list failed with HTTP ${listResponse.status}`);
  }

  return sessionId;
}

function extractOraclePayload(response: ToolCallResponse): unknown {
  if (response.error?.message) {
    throw new Error(response.error.message);
  }
  if (!response.result) {
    throw new Error("Pythia returned an empty MCP response.");
  }
  if (response.result.isError) {
    const errorText = response.result.content
      ?.map((item) => item.text)
      .filter(Boolean)
      .join("\n");
    throw new Error(errorText || "Pythia returned an MCP tool error.");
  }
  if (response.result.structuredContent !== undefined) {
    return response.result.structuredContent;
  }
  const text =
    response.result.content
      ?.map((item) => item.text)
      .filter(Boolean)
      .join("\n") ?? "";
  if (!text.trim()) {
    return { ok: true };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { response: text };
  }
}

async function callOracleTool(params: {
  fetchImpl: typeof fetch;
  url: string;
  sessionId: string;
  query: string;
  context?: string;
  agentId: string;
}): Promise<Response> {
  return await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": params.sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name: "consult_oracle",
        arguments: {
          query: params.query,
          ...(params.context ? { context: params.context } : {}),
          agent_id: params.agentId,
        },
      },
    }),
  });
}

async function maybeRecordPaidResponse(params: {
  statePath: string;
  req: PaymentRequirementLike;
  expectedPriceUsd?: number;
  response: Response;
}): Promise<void> {
  const paymentResponse = params.response.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponse) {
    return;
  }

  const nextState = await loadPaymentState(params.statePath);
  const dayKey = currentUtcDayKey();
  const currentSpend = nextState.dailySpendUsd?.[dayKey] ?? 0;
  if (params.expectedPriceUsd !== undefined) {
    nextState.dailySpendUsd = {
      ...(nextState.dailySpendUsd ?? {}),
      [dayKey]: currentSpend + params.expectedPriceUsd,
    };
  }

  let transaction: string | undefined;
  try {
    const decoded = decodePaymentResponseHeader(paymentResponse);
    transaction =
      typeof decoded.transaction === "string" && decoded.transaction.trim()
        ? decoded.transaction.trim()
        : undefined;
  } catch {
    transaction = undefined;
  }

  nextState.history = [
    {
      ts: Date.now(),
      usd: params.expectedPriceUsd,
      transaction,
      network: params.req.network,
      asset: params.req.asset,
      payTo: params.req.payTo,
    },
    ...(nextState.history ?? []),
  ].slice(0, 100);

  await savePaymentState(params.statePath, nextState);
}

function parseToolCallHttpError(params: {
  response: Response;
  walletEnvVar: string;
  serviceName: string;
}): never {
  if (params.response.status === 402) {
    throw new Error(
      `${params.serviceName} requires x402 payment, but ${params.walletEnvVar} is not configured.`,
    );
  }
  throw new Error(`${params.serviceName} failed with HTTP ${params.response.status}.`);
}

export function createPythiaOracleTool(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext) {
  const config = resolvePluginConfig(api, ctx);
  const statePath = resolveStateFilePath(ctx);
  return {
    name: "consult_oracle",
    label: "Consult Oracle",
    description:
      "Ask Pythia Oracle for a sideways reading on the real structure of a project or decision problem.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "The blunt version of the real question.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional context about what has been tried or where the project is stuck.",
        }),
      ),
      agent_id: Type.Optional(
        Type.String({
          description: "Optional override for the identity used by Pythia's free tier and billing.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = readStringParam(params, "query", { required: true });
      const context = readStringParam(params, "context");
      const agentId = readStringParam(params, "agent_id") ?? config.defaultAgentId;
      if (!query) {
        throw new ToolInputError("query required");
      }

      const walletPrivateKey = readWalletPrivateKey(config.walletPrivateKeyEnvVar);
      const approvalGate = await createApprovalGate({
        api,
        ctx,
        config,
        statePath,
      });

      const paymentReq: PaymentRequirementLike = {
        network: "eip155:8453",
        asset: "USDC",
        amount: "unknown",
        payTo: "unknown",
      };

      const fetchImpl =
        walletPrivateKey === undefined
          ? fetch
          : wrapFetchWithPayment(
              fetch,
              new x402Client()
                .register(
                  "eip155:*",
                  new ExactEvmScheme(toClientEvmSigner(privateKeyToAccount(walletPrivateKey))),
                )
                .onBeforePaymentCreation(async ({ selectedRequirements }) => {
                  paymentReq.network = selectedRequirements.network;
                  paymentReq.asset = selectedRequirements.asset;
                  paymentReq.amount = selectedRequirements.amount;
                  paymentReq.payTo = selectedRequirements.payTo;
                  const approval = await approvalGate({
                    network: selectedRequirements.network,
                    asset: selectedRequirements.asset,
                    amount: selectedRequirements.amount,
                    payTo: selectedRequirements.payTo,
                  });
                  return approval;
                }),
            );

      const sessionId = await openMcpSession({
        fetchImpl,
        url: config.url,
        clientName: "openclaw-pythia-oracle",
        clientVersion: api.runtime.version,
      });

      const toolResponse = await callOracleTool({
        fetchImpl,
        url: config.url,
        sessionId,
        query,
        context,
        agentId,
      });

      if (!toolResponse.ok) {
        parseToolCallHttpError({
          response: toolResponse,
          walletEnvVar: config.walletPrivateKeyEnvVar,
          serviceName: config.serviceName,
        });
      }

      await maybeRecordPaidResponse({
        statePath,
        req: paymentReq,
        expectedPriceUsd: config.expectedPriceUsd,
        response: toolResponse,
      });

      const responseBody = (await toolResponse.json()) as ToolCallResponse;
      return jsonResult(extractOraclePayload(responseBody));
    },
  };
}

export const __testing = {
  DEFAULT_EXPECTED_PRICE_USD,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  buildGrantKey,
  buildApprovalPrompt,
  resolvePluginConfig,
  loadPaymentState,
  savePaymentState,
  maybeRecordPaidResponse,
  extractOraclePayload,
};
