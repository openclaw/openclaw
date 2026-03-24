import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import {
  wrapFetchWithPayment,
  x402Client,
  x402HTTPClient,
  decodePaymentResponseHeader,
} from "@x402/fetch";
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
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

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
  scheme: string;
  network: `${string}:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type X402PaymentRequired = {
  x402Version: number;
  accepts: PaymentRequirementLike[];
  error?: string;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
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

function tryParseSseJsonPayload(buffer: string): unknown | undefined {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) {
      continue;
    }
    try {
      return JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readMcpJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await response.json()) as T;
  }

  const raw = await response.text();
  const parsed = tryParseSseJsonPayload(raw);
  if (parsed !== undefined) {
    return parsed as T;
  }

  throw new Error("Pythia returned an event stream without a JSON payload.");
}

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

function inferAssetSymbol(asset: string): string {
  const trimmed = asset.trim();
  if (!trimmed) {
    return "token";
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "usdc" || normalized === BASE_USDC_ADDRESS) {
    return "USDC";
  }
  return trimmed.startsWith("0x") ? trimmed : trimmed.toUpperCase();
}

function inferAssetDecimals(req: PaymentRequirementLike): number | undefined {
  const normalized = req.asset.trim().toLowerCase();
  if (normalized === "usdc" || normalized === BASE_USDC_ADDRESS) {
    return 6;
  }
  return undefined;
}

function formatAtomicAmount(amount: string, decimals: number): string | undefined {
  if (!/^\d+$/.test(amount)) {
    return undefined;
  }
  const raw = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) {
    return whole.toString();
  }
  const paddedFraction = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${paddedFraction}`;
}

// x402 prices are returned in token base units. Normalize them before surfacing
// them to the model so future payment-capability work does not leak raw onchain
// amounts like "25000 USDC" to users.
function formatHumanPaymentAmount(params: {
  req: PaymentRequirementLike;
  fallbackUsd?: number;
}): string {
  const symbol = inferAssetSymbol(params.req.asset);
  const decimals = inferAssetDecimals(params.req);
  const normalized =
    decimals !== undefined ? formatAtomicAmount(params.req.amount.trim(), decimals) : undefined;
  if (normalized) {
    return `${normalized} ${symbol}`;
  }
  if (params.fallbackUsd !== undefined) {
    return `${formatUsd(params.fallbackUsd)} ${symbol}`;
  }
  return `${params.req.amount} base units of ${symbol}`;
}

function describePaymentRequirement(params: {
  req: PaymentRequirementLike;
  fallbackUsd?: number;
}): string {
  return `${formatHumanPaymentAmount(params)} on ${params.req.network}`;
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
    `Price: ${describePaymentRequirement({ req: params.req, fallbackUsd: params.config.expectedPriceUsd })}`,
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

  const initializeBody = await readMcpJsonResponse<MpcInitializeResponse>(initializeResponse);
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

function extractToolErrorText(response: ToolCallResponse): string | undefined {
  if (!response.result?.isError) {
    return undefined;
  }
  const errorText = response.result.content
    ?.map((item) => item.text)
    .filter(Boolean)
    .join("\n")
    .trim();
  return errorText || undefined;
}

function parseX402PaymentRequired(text: string | undefined): X402PaymentRequired | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<X402PaymentRequired>;
    if (typeof parsed.x402Version !== "number" || !Array.isArray(parsed.accepts)) {
      return undefined;
    }
    const accepts = parsed.accepts.filter(
      (entry): entry is PaymentRequirementLike =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.network === "string" &&
        entry.network.includes(":") &&
        typeof entry.asset === "string" &&
        typeof entry.amount === "string" &&
        typeof entry.payTo === "string",
    );
    if (accepts.length === 0) {
      return undefined;
    }
    const resource =
      parsed.resource &&
      typeof parsed.resource === "object" &&
      typeof parsed.resource.url === "string" &&
      parsed.resource.url.trim()
        ? {
            url: parsed.resource.url,
            description:
              typeof parsed.resource.description === "string"
                ? parsed.resource.description
                : undefined,
            mimeType:
              typeof parsed.resource.mimeType === "string" ? parsed.resource.mimeType : undefined,
          }
        : { url: "mcp://tool/consult_oracle" };
    return {
      x402Version: parsed.x402Version,
      accepts: accepts.map((entry) => ({
        ...entry,
        scheme: typeof entry.scheme === "string" && entry.scheme.trim() ? entry.scheme : "exact",
        maxTimeoutSeconds:
          typeof entry.maxTimeoutSeconds === "number" ? entry.maxTimeoutSeconds : 300,
        extra: entry.extra && typeof entry.extra === "object" ? entry.extra : {},
      })),
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      resource,
    };
  } catch {
    return undefined;
  }
}

async function callOracleTool(params: {
  fetchImpl: typeof fetch;
  url: string;
  sessionId: string;
  query: string;
  context?: string;
  agentId: string;
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  return await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": params.sessionId,
      ...(params.extraHeaders ?? {}),
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
        scheme: "exact",
        network: "eip155:8453",
        asset: "USDC",
        amount: "unknown",
        payTo: "unknown",
        maxTimeoutSeconds: 300,
        extra: {},
      };

      const paymentClient =
        walletPrivateKey === undefined
          ? undefined
          : new x402Client()
              .register(
                "eip155:*",
                new ExactEvmScheme(toClientEvmSigner(privateKeyToAccount(walletPrivateKey))),
              )
              .onBeforePaymentCreation(async ({ selectedRequirements }) => {
                paymentReq.scheme = selectedRequirements.scheme;
                paymentReq.network = selectedRequirements.network;
                paymentReq.asset = selectedRequirements.asset;
                paymentReq.amount = selectedRequirements.amount;
                paymentReq.payTo = selectedRequirements.payTo;
                const approval = await approvalGate({
                  scheme: selectedRequirements.scheme,
                  network: selectedRequirements.network,
                  asset: selectedRequirements.asset,
                  amount: selectedRequirements.amount,
                  payTo: selectedRequirements.payTo,
                  maxTimeoutSeconds: selectedRequirements.maxTimeoutSeconds,
                  extra: selectedRequirements.extra,
                });
                return approval;
              });
      const fetchImpl =
        paymentClient === undefined ? fetch : wrapFetchWithPayment(fetch, paymentClient);
      const paymentHttpClient = paymentClient ? new x402HTTPClient(paymentClient) : undefined;

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

      let responseBody = await readMcpJsonResponse<ToolCallResponse>(toolResponse);
      const paymentRequired = parseX402PaymentRequired(extractToolErrorText(responseBody));
      if (paymentRequired) {
        if (!paymentClient || !paymentHttpClient) {
          throw new Error(
            `${config.serviceName} requires x402 payment of ${describePaymentRequirement({ req: paymentRequired.accepts[0]!, fallbackUsd: config.expectedPriceUsd })}, but ${config.walletPrivateKeyEnvVar} is not configured.`,
          );
        }
        const paymentPayload = await paymentClient.createPaymentPayload(paymentRequired);
        const paymentHeaders = paymentHttpClient.encodePaymentSignatureHeader(paymentPayload);
        const paidToolResponse = await callOracleTool({
          fetchImpl: fetch,
          url: config.url,
          sessionId,
          query,
          context,
          agentId,
          extraHeaders: paymentHeaders,
        });
        if (!paidToolResponse.ok) {
          parseToolCallHttpError({
            response: paidToolResponse,
            walletEnvVar: config.walletPrivateKeyEnvVar,
            serviceName: config.serviceName,
          });
        }
        await maybeRecordPaidResponse({
          statePath,
          req: {
            scheme: paymentRequired.accepts[0]?.scheme,
            network: paymentRequired.accepts[0]?.network ?? paymentReq.network,
            asset: paymentRequired.accepts[0]?.asset ?? paymentReq.asset,
            amount: paymentRequired.accepts[0]?.amount ?? paymentReq.amount,
            payTo: paymentRequired.accepts[0]?.payTo ?? paymentReq.payTo,
            maxTimeoutSeconds:
              paymentRequired.accepts[0]?.maxTimeoutSeconds ?? paymentReq.maxTimeoutSeconds,
            extra: paymentRequired.accepts[0]?.extra ?? paymentReq.extra,
          },
          expectedPriceUsd: config.expectedPriceUsd,
          response: paidToolResponse,
        });
        responseBody = await readMcpJsonResponse<ToolCallResponse>(paidToolResponse);
        const paymentRequiredAfterRetry = parseX402PaymentRequired(
          extractToolErrorText(responseBody),
        );
        if (paymentRequiredAfterRetry) {
          throw new Error(
            `${config.serviceName} still requires x402 payment of ${describePaymentRequirement({ req: paymentRequiredAfterRetry.accepts[0]!, fallbackUsd: config.expectedPriceUsd })} after an automatic payment attempt.`,
          );
        }
      }
      return jsonResult(extractOraclePayload(responseBody));
    },
  };
}

export const __testing = {
  DEFAULT_EXPECTED_PRICE_USD,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  buildGrantKey,
  buildApprovalPrompt,
  describePaymentRequirement,
  formatHumanPaymentAmount,
  resolvePluginConfig,
  loadPaymentState,
  savePaymentState,
  maybeRecordPaidResponse,
  extractOraclePayload,
  parseX402PaymentRequired,
  extractToolErrorText,
  readMcpJsonResponse,
};
