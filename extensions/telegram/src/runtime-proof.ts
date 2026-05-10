import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

export const TELEGRAM_RUNTIME_PROOF_EVENT = "telegram_runtime_proof";
export const TELEGRAM_RUNTIME_PROOF_SCHEMA_VERSION = 1;

export const TELEGRAM_RUNTIME_PROOF_KINDS = {
  inboundAccepted: "inbound_accepted",
  modelInvocationStarted: "model_invocation_started",
  assistantResponseObserved: "assistant_response_observed",
  telegramDeliveryObserved: "telegram_delivery_observed",
} as const;

export type TelegramRuntimeProofKind =
  (typeof TELEGRAM_RUNTIME_PROOF_KINDS)[keyof typeof TELEGRAM_RUNTIME_PROOF_KINDS];

const RUN_ID_RE = /^[A-Za-z0-9_-]{4,80}$/u;
const RUN_ID_MARKER_RE = /(?:^|\b)(?:run_id|runId|run-id)\s*[:=]\s*([A-Za-z0-9_-]{4,80})(?:\b|$)/iu;
const E2E_SLUG_PREFIX = "e2e-";
const DEFAULT_PROOF_JSONL_FILENAME = "telegram-runtime-proof.jsonl";

type RuntimeProofConfigLike = {
  configSlug?: unknown;
  meta?: { configSlug?: unknown } | undefined;
};

export type TelegramRuntimeProofBase = {
  runId?: string;
  accountId?: string;
  sessionKeyHash?: string;
  messageIdHash?: string;
};

export type TelegramRuntimeProofEvent = TelegramRuntimeProofBase & {
  event: TelegramRuntimeProofKind;
  kind: TelegramRuntimeProofKind;
  type: TelegramRuntimeProofKind;
  proofEvent: typeof TELEGRAM_RUNTIME_PROOF_EVENT;
  schemaVersion: typeof TELEGRAM_RUNTIME_PROOF_SCHEMA_VERSION;
  status: "observed";
  channel: "telegram";
  at: string;
};

export function normalizeTelegramRuntimeProofRunId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return RUN_ID_RE.test(trimmed) ? trimmed : undefined;
}

export function extractTelegramRuntimeProofRunIdFromText(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.includes("run")) {
    return undefined;
  }
  const match = RUN_ID_MARKER_RE.exec(text.slice(0, 2_000));
  return normalizeTelegramRuntimeProofRunId(match?.[1]);
}

function extractRunIdFromConfigSlug(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith(E2E_SLUG_PREFIX)) {
    return undefined;
  }
  return normalizeTelegramRuntimeProofRunId(trimmed.slice(E2E_SLUG_PREFIX.length));
}

function readConfigSlug(cfg: unknown): unknown {
  const maybe = cfg as RuntimeProofConfigLike | undefined;
  return maybe?.configSlug ?? maybe?.meta?.configSlug;
}

export function resolveTelegramRuntimeProofRunId(params: {
  env?: NodeJS.ProcessEnv;
  textCandidates?: unknown[];
  cfg?: unknown;
}): string | undefined {
  const envRunId = normalizeTelegramRuntimeProofRunId(params.env?.STOMME_E2E_RUN_ID);
  if (envRunId) {
    return envRunId;
  }
  for (const candidate of params.textCandidates ?? []) {
    const textRunId = extractTelegramRuntimeProofRunIdFromText(candidate);
    if (textRunId) {
      return textRunId;
    }
  }
  return extractRunIdFromConfigSlug(readConfigSlug(params.cfg));
}

export function hashTelegramRuntimeProofId(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    raw = String(value);
  } else {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12);
}

export function buildTelegramRuntimeProofBase(params: {
  accountId?: unknown;
  sessionKey?: unknown;
  messageId?: unknown;
  cfg?: unknown;
  env?: NodeJS.ProcessEnv;
  textCandidates?: unknown[];
}): TelegramRuntimeProofBase {
  return {
    runId: resolveTelegramRuntimeProofRunId({
      env: params.env,
      textCandidates: params.textCandidates,
      cfg: params.cfg,
    }),
    accountId: typeof params.accountId === "string" ? params.accountId : undefined,
    sessionKeyHash: hashTelegramRuntimeProofId(params.sessionKey),
    messageIdHash: hashTelegramRuntimeProofId(params.messageId),
  };
}

export function createTelegramRuntimeProofEvent(
  kind: TelegramRuntimeProofKind,
  base: TelegramRuntimeProofBase,
): TelegramRuntimeProofEvent {
  return {
    event: kind,
    kind,
    type: kind,
    proofEvent: TELEGRAM_RUNTIME_PROOF_EVENT,
    schemaVersion: TELEGRAM_RUNTIME_PROOF_SCHEMA_VERSION,
    status: "observed",
    channel: "telegram",
    ...(base.runId ? { runId: base.runId } : {}),
    ...(base.accountId ? { accountId: base.accountId } : {}),
    ...(base.sessionKeyHash ? { sessionKeyHash: base.sessionKeyHash } : {}),
    ...(base.messageIdHash ? { messageIdHash: base.messageIdHash } : {}),
    at: new Date().toISOString(),
  };
}

export function resolveTelegramRuntimeProofJsonlPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return join(stateDir, "logs", DEFAULT_PROOF_JSONL_FILENAME);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return join(dirname(configPath), "logs", DEFAULT_PROOF_JSONL_FILENAME);
  }
  return undefined;
}

function appendTelegramRuntimeProofJsonl(event: TelegramRuntimeProofEvent, env: NodeJS.ProcessEnv) {
  const proofPath = resolveTelegramRuntimeProofJsonlPath(env);
  if (!proofPath) {
    return;
  }
  try {
    mkdirSync(dirname(proofPath), { recursive: true, mode: 0o700 });
    appendFileSync(proofPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Runtime proof is diagnostic-only and must never block Telegram delivery.
  }
}

export function emitTelegramRuntimeProofEvent(params: {
  logger: Pick<SubsystemLogger, "raw">;
  base: TelegramRuntimeProofBase;
  kind: TelegramRuntimeProofKind;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!params.base.runId) {
    return;
  }
  const event = createTelegramRuntimeProofEvent(params.kind, params.base);
  const env = params.env ?? process.env;
  // The Tauri E2E harness scans sanitized runtime log lines for this marker and
  // parses the following JSON payload. Keep this as one line with no prompt,
  // assistant text, chat id, sender id, token, or provider secret fields.
  params.logger.raw(`${TELEGRAM_RUNTIME_PROOF_EVENT} ${JSON.stringify(event)}`);
  appendTelegramRuntimeProofJsonl(event, env);
}
